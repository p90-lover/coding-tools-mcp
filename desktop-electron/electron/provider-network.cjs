const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const STORE_VERSION = 1;
const ACCOUNT_AUTH = new Set(["oauth", "api_key", "browser_session", "local_proxy"]);
const ACCOUNT_STATUS = new Set(["pending", "connected", "expired", "error", "disabled"]);
const PROXY_PROTOCOLS = new Set(["http", "https", "socks4", "socks5"]);
const PROXY_SCOPES = new Set([
  "all",
  "browser",
  "provider",
  "oauth",
  "paseo",
  "anneal",
  "mcp",
  "websocket",
  "http",
  "update",
]);
const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::1", "*.localhost"];
const PROVIDER_LOGIN_URLS = Object.freeze({
  "codex-oauth": "https://chatgpt.com/",
  "chatgpt-web": "https://chatgpt.com/",
  "claude-oauth": "https://claude.ai/login",
  "ai-studio-reverse-proxy": "https://aistudio.google.com/",
  "gemini-reverse-proxy": "https://aistudio.google.com/",
});
const ANTIGRAVITY_PROVIDER_ID = "cliproxyapi-antigravity";
const DEFAULT_ANTIGRAVITY_BASE_URL = "http://127.0.0.1:8317";
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000;

function defaultState() {
  return {
    version: STORE_VERSION,
    accounts: [],
    proxyProfiles: [],
    routing: {
      globalEnabled: false,
      globalProfileId: null,
      providers: [],
      accounts: [],
    },
    secrets: {
      accounts: {},
      proxies: {},
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function requiredText(value, label, maximum = 200) {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function optionalText(value, maximum = 500) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Text value is invalid");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error("Text value is too long");
  return normalized;
}

function timestamp(value, fallback = new Date().toISOString()) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 128);
}

function normalizeBypass(value) {
  const entries = Array.isArray(value) ? value : DEFAULT_BYPASS;
  return [...new Set(entries
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 256);
}

function normalizeScopes(value) {
  const entries = Array.isArray(value) ? value : ["all"];
  const scopes = [...new Set(entries.filter((item) => PROXY_SCOPES.has(item)))];
  return scopes.length > 0 ? scopes : ["all"];
}

function normalizeEndpoint(value) {
  if (!value || typeof value !== "object") throw new Error("Proxy endpoint is required");
  const protocol = requiredText(value.protocol, "Proxy protocol", 16).toLowerCase();
  if (!PROXY_PROTOCOLS.has(protocol)) throw new Error("Unsupported proxy protocol");
  const host = requiredText(value.host, "Proxy host", 255);
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Proxy port must be between 1 and 65535");
  }
  return { protocol, host, port };
}

function normalizeAccount(account) {
  if (!account || typeof account !== "object") return null;
  try {
    const auth = ACCOUNT_AUTH.has(account.auth) ? account.auth : "api_key";
    const status = ACCOUNT_STATUS.has(account.status) ? account.status : "pending";
    const normalized = {
      id: requiredText(account.id, "Account ID", 160),
      providerId: requiredText(account.providerId, "Provider ID", 160),
      label: requiredText(account.label, "Account label", 160),
      identity: optionalText(account.identity, 320),
      endpoint: optionalText(account.endpoint, 2_048),
      auth,
      status,
      enabled: account.enabled !== false,
      isDefault: account.isDefault === true,
      models: normalizeModels(account.models),
      proxyProfileId: optionalText(account.proxyProfileId, 160),
      createdAt: timestamp(account.createdAt),
      updatedAt: timestamp(account.updatedAt),
      lastUsedAt: account.lastUsedAt ? timestamp(account.lastUsedAt, undefined) : undefined,
      archivedAt: account.archivedAt ? timestamp(account.archivedAt, undefined) : undefined,
      error: optionalText(account.error, 500),
    };
    if (normalized.archivedAt) {
      normalized.enabled = false;
      normalized.isDefault = false;
      normalized.status = "disabled";
    }
    return normalized;
  } catch {
    return null;
  }
}

function normalizeProxyProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  try {
    return {
      id: requiredText(profile.id, "Proxy profile ID", 160),
      name: requiredText(profile.name, "Proxy profile name", 160),
      enabled: profile.enabled !== false,
      endpoint: normalizeEndpoint(profile.endpoint),
      scopes: normalizeScopes(profile.scopes),
      bypass: normalizeBypass(profile.bypass),
      hasAuthentication: profile.hasAuthentication === true,
      createdAt: timestamp(profile.createdAt),
      updatedAt: timestamp(profile.updatedAt),
      lastCheckedAt: profile.lastCheckedAt ? timestamp(profile.lastCheckedAt, undefined) : undefined,
      latencyMs: Number.isFinite(profile.latencyMs) && profile.latencyMs >= 0
        ? Math.round(profile.latencyMs)
        : undefined,
      lastError: optionalText(profile.lastError, 500),
      archivedAt: profile.archivedAt ? timestamp(profile.archivedAt, undefined) : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeProviderPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  try {
    return {
      providerId: requiredText(policy.providerId, "Provider ID", 160),
      inheritGlobal: policy.inheritGlobal !== false,
      profileId: optionalText(policy.profileId, 160),
    };
  } catch {
    return null;
  }
}

function normalizeAccountPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  try {
    return {
      accountId: requiredText(policy.accountId, "Account ID", 160),
      providerId: requiredText(policy.providerId, "Provider ID", 160),
      inheritProvider: policy.inheritProvider !== false,
      inheritGlobal: policy.inheritGlobal !== false,
      profileId: optionalText(policy.profileId, 160),
    };
  } catch {
    return null;
  }
}

function normalizeState(parsed) {
  const fallback = defaultState();
  if (!parsed || parsed.version !== STORE_VERSION) return fallback;
  const accounts = Array.isArray(parsed.accounts)
    ? parsed.accounts.map(normalizeAccount).filter(Boolean)
    : [];
  const proxyProfiles = Array.isArray(parsed.proxyProfiles)
    ? parsed.proxyProfiles.map(normalizeProxyProfile).filter(Boolean)
    : [];
  const routing = parsed.routing && typeof parsed.routing === "object" ? parsed.routing : {};
  const secrets = parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {};
  return {
    version: STORE_VERSION,
    accounts: normalizeAccountDefaults(accounts),
    proxyProfiles,
    routing: {
      globalEnabled: routing.globalEnabled === true,
      globalProfileId: typeof routing.globalProfileId === "string"
        ? routing.globalProfileId
        : null,
      providers: Array.isArray(routing.providers)
        ? routing.providers.map(normalizeProviderPolicy).filter(Boolean)
        : [],
      accounts: Array.isArray(routing.accounts)
        ? routing.accounts.map(normalizeAccountPolicy).filter(Boolean)
        : [],
    },
    secrets: {
      accounts: secrets.accounts && typeof secrets.accounts === "object" ? secrets.accounts : {},
      proxies: secrets.proxies && typeof secrets.proxies === "object" ? secrets.proxies : {},
    },
  };
}

function requiresStoredCredential(auth) {
  return auth === "api_key" || auth === "local_proxy";
}

function accountUsable(account) {
  return account.enabled && !account.archivedAt && account.status === "connected";
}

function normalizeAccountDefaults(accounts) {
  const defaults = new Map();
  for (const account of accounts) {
    if (accountUsable(account) && account.isDefault) defaults.set(account.providerId, account.id);
  }
  for (const account of accounts) {
    if (!defaults.has(account.providerId) && accountUsable(account)) {
      defaults.set(account.providerId, account.id);
    }
  }
  return accounts.map((account) => ({
    ...account,
    isDefault: accountUsable(account) && defaults.get(account.providerId) === account.id,
  }));
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
      const encoded = fs.readFileSync(keyPath, "utf8").trim();
      const existing = Buffer.from(encoded, "base64");
      if (existing.length === 32) {
        fallbackKey = existing;
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
    const key = loadFallbackKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
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
        const plain = safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
        return JSON.parse(plain);
      }
      if (envelope.scheme !== "aes-256-gcm-v1") return null;
      const key = loadFallbackKey();
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
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

  return { encrypt, decrypt };
}

function createProviderNetworkStore({ filePath, keyPath, safeStorage }) {
  const codec = createSecretCodec({ safeStorage, keyPath });
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    state = defaultState();
  }

  function write() {
    writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function publicSnapshot() {
    return {
      version: STORE_VERSION,
      accounts: state.accounts.map((account) => ({
        ...clone(account),
        hasCredential: Boolean(state.secrets.accounts[account.id]),
      })),
      proxyProfiles: state.proxyProfiles.map((profile) => ({ ...clone(profile) })),
      routing: clone(state.routing),
    };
  }

  function findAccount(accountId) {
    return state.accounts.find((account) => account.id === accountId);
  }

  function findProxy(profileId) {
    return state.proxyProfiles.find((profile) => profile.id === profileId);
  }

  function activeProxy(profileId) {
    const profile = findProxy(profileId);
    return profile && profile.enabled && !profile.archivedAt ? profile : null;
  }

  function saveAccount(input) {
    if (!input || typeof input !== "object") throw new Error("Provider account is required");
    const now = new Date().toISOString();
    const id = optionalText(input.id, 160) || crypto.randomUUID();
    const providerId = requiredText(input.providerId, "Provider ID", 160);
    const auth = requiredText(input.auth, "Authentication type", 32);
    if (!ACCOUNT_AUTH.has(auth)) throw new Error("Unsupported provider authentication type");
    const index = state.accounts.findIndex((account) => account.id === id);
    const previous = index >= 0 ? state.accounts[index] : null;
    if (previous && previous.providerId !== providerId) {
      throw new Error("An account cannot move between providers");
    }
    const suppliedSecret = input.secret && typeof input.secret === "object"
      ? Object.fromEntries(Object.entries(input.secret).filter(([, value]) => (
        typeof value === "string" && value.length > 0
      )))
      : null;
    if (suppliedSecret && Object.keys(suppliedSecret).length > 0) {
      state.secrets.accounts[id] = codec.encrypt(suppliedSecret);
    }
    const hasCredential = Boolean(state.secrets.accounts[id]);
    const statusInput = input.status ?? previous?.status;
    let status = ACCOUNT_STATUS.has(statusInput)
      ? statusInput
      : suppliedSecret ? "connected" : "pending";
    if (status === "connected" && requiresStoredCredential(auth) && !hasCredential) {
      status = "pending";
    }
    const account = normalizeAccount({
      id,
      providerId,
      label: input.label,
      identity: input.identity,
      endpoint: input.endpoint ?? previous?.endpoint,
      auth,
      status,
      enabled: input.enabled ?? previous?.enabled ?? true,
      isDefault: input.isDefault ?? previous?.isDefault ?? false,
      models: input.models ?? previous?.models ?? [],
      proxyProfileId: input.proxyProfileId ?? previous?.proxyProfileId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: previous?.lastUsedAt,
      archivedAt: previous?.archivedAt,
      error: input.error,
    });
    if (!account) throw new Error("Provider account is invalid");
    if (index >= 0) state.accounts[index] = account;
    else state.accounts.push(account);
    if (account.isDefault && accountUsable(account)) {
      for (const sibling of state.accounts) {
        if (sibling.providerId === providerId && sibling.id !== id) sibling.isDefault = false;
      }
    }
    state.accounts = normalizeAccountDefaults(state.accounts);
    write();
    return publicSnapshot();
  }

  function setDefaultAccount(providerId, accountId) {
    const account = findAccount(accountId);
    if (!account || account.providerId !== providerId) throw new Error("Provider account was not found");
    if (!accountUsable(account)
      || (requiresStoredCredential(account.auth) && !state.secrets.accounts[account.id])) {
      throw new Error("Only a connected account with its required credential can be the default");
    }
    for (const candidate of state.accounts) {
      if (candidate.providerId === providerId) candidate.isDefault = candidate.id === accountId;
    }
    write();
    return publicSnapshot();
  }

  function setAccountEnabled(accountId, enabled) {
    const account = findAccount(accountId);
    if (!account) throw new Error("Provider account was not found");
    if (account.archivedAt && enabled) throw new Error("Archived accounts cannot be enabled");
    account.enabled = enabled === true;
    account.updatedAt = new Date().toISOString();
    if (!account.enabled) {
      account.isDefault = false;
      account.status = "disabled";
    } else if (account.status === "disabled") {
      account.status = requiresStoredCredential(account.auth) && !state.secrets.accounts[account.id]
        ? "pending"
        : "connected";
    }
    state.accounts = normalizeAccountDefaults(state.accounts);
    write();
    return publicSnapshot();
  }

  function archiveAccount(accountId) {
    const account = findAccount(accountId);
    if (!account) throw new Error("Provider account was not found");
    const now = new Date().toISOString();
    Object.assign(account, {
      enabled: false,
      isDefault: false,
      status: "disabled",
      archivedAt: now,
      updatedAt: now,
    });
    state.accounts = normalizeAccountDefaults(state.accounts);
    write();
    return publicSnapshot();
  }

  function updateAccountConnection(accountId, input = {}) {
    const account = findAccount(accountId);
    if (!account || account.archivedAt) throw new Error("Provider account was not found");
    const now = new Date().toISOString();
    if (ACCOUNT_STATUS.has(input.status)) account.status = input.status;
    if (Object.hasOwn(input, "identity")) account.identity = optionalText(input.identity, 320);
    if (Object.hasOwn(input, "endpoint")) account.endpoint = optionalText(input.endpoint, 2_048);
    if (Array.isArray(input.models)) account.models = normalizeModels(input.models).sort();
    account.error = optionalText(input.error, 500);
    account.updatedAt = now;
    if (account.status === "connected") {
      account.enabled = true;
      account.lastUsedAt = now;
    }
    if (account.status === "disabled") {
      account.enabled = false;
      account.isDefault = false;
    }
    state.accounts = normalizeAccountDefaults(state.accounts);
    write();
    return publicSnapshot();
  }

  function saveProxyProfile(input) {
    if (!input || typeof input !== "object") throw new Error("Proxy profile is required");
    const now = new Date().toISOString();
    const id = optionalText(input.id, 160) || crypto.randomUUID();
    const index = state.proxyProfiles.findIndex((profile) => profile.id === id);
    const previous = index >= 0 ? state.proxyProfiles[index] : null;
    const username = typeof input.username === "string" ? input.username : undefined;
    const password = typeof input.password === "string" ? input.password : undefined;
    if (username !== undefined || password !== undefined) {
      state.secrets.proxies[id] = codec.encrypt({ username: username || "", password: password || "" });
    }
    const profile = normalizeProxyProfile({
      id,
      name: input.name,
      enabled: input.enabled ?? previous?.enabled ?? true,
      endpoint: input.endpoint,
      scopes: input.scopes ?? previous?.scopes ?? ["all"],
      bypass: input.bypass ?? previous?.bypass ?? DEFAULT_BYPASS,
      hasAuthentication: Boolean(state.secrets.proxies[id]),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: previous?.lastCheckedAt,
      latencyMs: previous?.latencyMs,
      lastError: previous?.lastError,
      archivedAt: previous?.archivedAt,
    });
    if (!profile) throw new Error("Proxy profile is invalid");
    if (index >= 0) state.proxyProfiles[index] = profile;
    else state.proxyProfiles.push(profile);
    write();
    return publicSnapshot();
  }

  function archiveProxyProfile(profileId) {
    const profile = findProxy(profileId);
    if (!profile) throw new Error("Proxy profile was not found");
    const now = new Date().toISOString();
    Object.assign(profile, { enabled: false, archivedAt: now, updatedAt: now });
    if (state.routing.globalProfileId === profileId) {
      state.routing.globalEnabled = false;
      state.routing.globalProfileId = null;
    }
    state.routing.providers = state.routing.providers.map((policy) => (
      policy.profileId === profileId ? { ...policy, profileId: undefined } : policy
    ));
    state.routing.accounts = state.routing.accounts.map((policy) => (
      policy.profileId === profileId ? { ...policy, profileId: undefined } : policy
    ));
    for (const account of state.accounts) {
      if (account.proxyProfileId === profileId) account.proxyProfileId = undefined;
    }
    write();
    return publicSnapshot();
  }

  function setGlobalRouting(input) {
    const enabled = input?.enabled === true;
    const profileId = optionalText(input?.profileId, 160) || null;
    if (enabled && !activeProxy(profileId)) throw new Error("Choose an enabled proxy profile first");
    state.routing.globalEnabled = enabled;
    state.routing.globalProfileId = profileId;
    write();
    return publicSnapshot();
  }

  function setProviderPolicy(input) {
    const providerId = requiredText(input?.providerId, "Provider ID", 160);
    const mode = input?.mode;
    const profileId = optionalText(input?.profileId, 160);
    if (mode === "profile" && !activeProxy(profileId)) throw new Error("Proxy profile was not found");
    const policy = mode === "direct"
      ? { providerId, inheritGlobal: false }
      : mode === "profile"
        ? { providerId, inheritGlobal: true, profileId }
        : { providerId, inheritGlobal: true };
    state.routing.providers = [
      ...state.routing.providers.filter((item) => item.providerId !== providerId),
      policy,
    ];
    write();
    return publicSnapshot();
  }

  function setAccountPolicy(input) {
    const accountId = requiredText(input?.accountId, "Account ID", 160);
    const account = findAccount(accountId);
    if (!account) throw new Error("Provider account was not found");
    const mode = input?.mode;
    const profileId = optionalText(input?.profileId, 160);
    if (mode === "profile" && !activeProxy(profileId)) throw new Error("Proxy profile was not found");
    const policy = mode === "direct"
      ? {
          accountId,
          providerId: account.providerId,
          inheritProvider: false,
          inheritGlobal: false,
        }
      : mode === "global"
        ? {
            accountId,
            providerId: account.providerId,
            inheritProvider: false,
            inheritGlobal: true,
          }
        : mode === "profile"
          ? {
              accountId,
              providerId: account.providerId,
              inheritProvider: true,
              inheritGlobal: true,
              profileId,
            }
          : {
              accountId,
              providerId: account.providerId,
              inheritProvider: true,
              inheritGlobal: true,
            };
    state.routing.accounts = [
      ...state.routing.accounts.filter((item) => item.accountId !== accountId),
      policy,
    ];
    write();
    return publicSnapshot();
  }

  function recordProxyHealth(profileId, result) {
    const profile = findProxy(profileId);
    if (!profile) throw new Error("Proxy profile was not found");
    profile.lastCheckedAt = new Date().toISOString();
    profile.latencyMs = result.reachable ? Math.max(0, Math.round(result.latencyMs || 0)) : undefined;
    profile.lastError = result.reachable ? undefined : optionalText(result.error, 500) || "Connection failed";
    profile.updatedAt = profile.lastCheckedAt;
    write();
    return publicSnapshot();
  }

  function accountSecret(accountId) {
    return codec.decrypt(state.secrets.accounts[accountId]);
  }

  function proxySecret(profileId) {
    return codec.decrypt(state.secrets.proxies[profileId]);
  }

  return {
    snapshot: publicSnapshot,
    saveAccount,
    setDefaultAccount,
    setAccountEnabled,
    archiveAccount,
    updateAccountConnection,
    saveProxyProfile,
    archiveProxyProfile,
    setGlobalRouting,
    setProviderPolicy,
    setAccountPolicy,
    recordProxyHealth,
    accountSecret,
    proxySecret,
    activeProxy,
  };
}

function proxyUrl(profile) {
  if (!profile) return null;
  const host = profile.endpoint.host.includes(":")
    ? `[${profile.endpoint.host.replace(/^\[|\]$/g, "")}]`
    : profile.endpoint.host;
  return `${profile.endpoint.protocol}://${host}:${profile.endpoint.port}`;
}

function testTcpEndpoint(profile, timeoutMs = 7_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect({ host: profile.endpoint.host, port: profile.endpoint.port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once("timeout", () => finish({ reachable: false, error: "Connection timed out" }));
    socket.once("error", (error) => finish({
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}


function loopbackHost(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.startsWith("127.");
}

function normalizeProviderBaseUrl(value) {
  const normalized = requiredText(value, "Provider endpoint", 2_048);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Provider endpoint is invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider endpoint must not contain credentials, query parameters, or fragments");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url))) {
    throw new Error("Provider endpoints require HTTPS; plain HTTP is limited to loopback");
  }
  let pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname.toLowerCase().endsWith("/v1")) pathname = pathname.slice(0, -3);
  url.pathname = pathname || "/";
  return url.toString().replace(/\/$/u, "");
}

function safeProviderLoginUrl(value) {
  let url;
  try {
    url = new URL(requiredText(value, "Provider login URL", 8_192));
  } catch {
    throw new Error("Provider login URL is invalid");
  }
  if (url.username || url.password) throw new Error("Provider login URL is unsafe");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url))) {
    throw new Error("Provider login URLs require HTTPS; plain HTTP is limited to loopback");
  }
  return url.toString();
}

function providerSessionFailureStatus(message) {
  return /expired|invalid[_ -]?grant|refresh token|reauth/i.test(String(message || ""))
    ? "expired"
    : "error";
}

function antigravityAuthFiles(value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  return files.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const provider = String(entry.provider ?? entry.type ?? "").trim().toLowerCase();
    return provider === "antigravity";
  });
}

function antigravityAuthFileName(entry) {
  const value = String(entry?.name ?? entry?.id ?? "").trim();
  return value || null;
}

function providerModelIds(value) {
  const models = Array.isArray(value?.models) ? value.models : [];
  return [...new Set(models.flatMap((entry) => {
    const id = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? entry.id
        : null;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort().slice(0, 128);
}

function createProviderNetworkController({
  app,
  browserPartition,
  getBrowserHost,
  logger,
  safeStorage,
  session,
  shell,
  userData,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  oauthPollIntervalMs = DEFAULT_OAUTH_POLL_INTERVAL_MS,
  oauthTimeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
}) {
  const directory = path.join(userData, "providers");
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "provider-network.json"),
    keyPath: path.join(directory, "provider-network.key"),
    safeStorage,
  });
  const ownedEnvironment = new Set();
  if (typeof fetchImpl !== "function") throw new Error("Provider network fetch implementation is unavailable");

  function clearOwnedEnvironment() {
    for (const name of ownedEnvironment) delete process.env[name];
    ownedEnvironment.clear();
  }

  function setOwnedEnvironment(name, value) {
    process.env[name] = value;
    ownedEnvironment.add(name);
  }

  async function applyGlobalRouting() {
    const snapshot = store.snapshot();
    const profile = snapshot.routing.globalEnabled
      ? store.activeProxy(snapshot.routing.globalProfileId)
      : null;
    const targets = [session.defaultSession, session.fromPartition(browserPartition)]
      .filter((value, index, list) => value && list.indexOf(value) === index);
    clearOwnedEnvironment();

    if (!profile) {
      await Promise.all(targets.map((target) => target.setProxy({ mode: "direct" })));
      logger.info("proxy.global_routing_disabled", {});
      return snapshot;
    }

    const route = proxyUrl(profile);
    const bypass = profile.bypass.join(",");
    await Promise.all(targets.map((target) => target.setProxy({
      mode: "fixed_servers",
      proxyRules: route,
      proxyBypassRules: bypass,
    })));
    setOwnedEnvironment("HTTP_PROXY", route);
    setOwnedEnvironment("HTTPS_PROXY", route);
    setOwnedEnvironment("ALL_PROXY", route);
    setOwnedEnvironment("NO_PROXY", profile.bypass.join(","));
    logger.info("proxy.global_routing_applied", {
      profileId: profile.id,
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: profile.endpoint.port,
      scopes: profile.scopes,
    });
    return snapshot;
  }

  function accountRecord(accountId) {
    const account = store.snapshot().accounts.find((item) => item.id === accountId && !item.archivedAt);
    if (!account) throw new Error("Provider account was not found");
    return account;
  }

  function antigravityConnection(account) {
    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) throw new Error("Enter the CLIProxyAPI management key before login or testing");
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_ANTIGRAVITY_BASE_URL,
    );
    return { baseUrl, managementKey };
  }

  async function managementJson(account, pathname) {
    const { baseUrl, managementKey } = antigravityConnection(account);
    const url = new URL(pathname, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutMs));
    timeout.unref?.();
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${managementKey}`,
          "X-Management-Key": managementKey,
        },
        signal: controller.signal,
      });
      let value = {};
      try {
        value = await response.json();
      } catch {
        value = {};
      }
      if (!response.ok) {
        const detail = typeof value?.error === "string" ? `: ${value.error.slice(0, 240)}` : "";
        throw new Error(`CLIProxyAPI management request failed (HTTP ${response.status})${detail}`);
      }
      return value;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("CLIProxyAPI management request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function inspectAntigravitySession(account, { baselineAuthNames = new Set() } = {}) {
    const listing = await managementJson(account, "/v0/management/auth-files");
    const files = antigravityAuthFiles(listing);
    if (files.length === 0) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: undefined,
      });
    }

    const identity = String(account.identity || "").trim().toLowerCase();
    const newlyCreated = files.find((entry) => {
      const name = antigravityAuthFileName(entry);
      return name && !baselineAuthNames.has(name);
    });
    const selected = files.find((entry) => {
      const candidate = String(entry.email ?? entry.label ?? "").trim().toLowerCase();
      return identity && candidate === identity;
    }) ?? newlyCreated ?? files.find((entry) => entry.disabled !== true) ?? files[0];
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";

    let models = Array.isArray(account.models) ? account.models : [];
    let modelError;
    if (status === "connected") {
      try {
        const name = String(selected.name ?? selected.id ?? "").trim();
        if (name) {
          const catalogue = await managementJson(
            account,
            `/v0/management/auth-files/models?name=${encodeURIComponent(name)}`,
          );
          const discovered = providerModelIds(catalogue);
          if (discovered.length > 0) models = discovered;
        }
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }

    return store.updateAccountConnection(account.id, {
      status,
      identity: selected.email ?? selected.label ?? account.identity,
      models,
      error: status === "connected" ? modelError : (selected.status_message || detail || undefined),
    });
  }

  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId !== ANTIGRAVITY_PROVIDER_ID) {
      throw new Error("Provider account health probing is not configured for this provider");
    }
    try {
      return await inspectAntigravitySession(account);
    } catch (error) {
      store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function openProviderLogin(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: "embedded", browser: browser || null };
    }
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
      let baselineAuthNames = new Set();
      try {
        const baseline = await managementJson(account, "/v0/management/auth-files");
        baselineAuthNames = new Set(
          antigravityAuthFiles(baseline)
            .map(antigravityAuthFileName)
            .filter(Boolean),
        );
      } catch (error) {
        logger.warn("provider.antigravity_baseline_failed", {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      store.updateAccountConnection(account.id, { status: "pending", error: undefined });
      const login = await managementJson(
        account,
        "/v0/management/antigravity-auth-url?is_webui=true",
      );
      const state = String(login?.state ?? "").trim();
      if (!state || login?.status !== "ok") throw new Error("CLIProxyAPI did not start Antigravity authentication");
      const loginUrl = safeProviderLoginUrl(login?.url);
      await shell.openExternal(loginUrl);

      const deadline = Date.now() + Math.max(1, oauthTimeoutMs);
      while (Date.now() <= deadline) {
        const status = await managementJson(
          account,
          `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`,
        );
        if (status?.status === "ok") {
          return {
            opened: true,
            mode: "external",
            state,
            snapshot: await inspectAntigravitySession(accountRecord(account.id), {
              baselineAuthNames,
            }),
          };
        }
        if (status?.status === "error") {
          const message = String(status.error || "Antigravity authentication failed");
          const snapshot = store.updateAccountConnection(account.id, {
            status: providerSessionFailureStatus(message),
            error: message,
          });
          const error = new Error(message);
          error.snapshot = snapshot;
          throw error;
        }
        await sleepImpl(Math.max(0, oauthPollIntervalMs));
      }
      const message = "Antigravity authentication timed out";
      const snapshot = store.updateAccountConnection(account.id, { status: "error", error: message });
      const error = new Error(message);
      error.snapshot = snapshot;
      throw error;
    }
    const url = PROVIDER_LOGIN_URLS[account.providerId];
    if (!url) throw new Error("This provider uses API key or custom endpoint authentication");
    await shell.openExternal(safeProviderLoginUrl(url));
    return { opened: true, mode: "external" };
  }

  async function testProxyProfile(profileId) {
    const profile = store.activeProxy(profileId);
    if (!profile) throw new Error("Proxy profile was not found or is disabled");
    const result = await testTcpEndpoint(profile);
    const snapshot = store.recordProxyHealth(profileId, result);
    logger[result.reachable ? "info" : "warn"]("proxy.profile_tested", {
      profileId,
      reachable: result.reachable,
      latencyMs: result.latencyMs,
      error: result.error,
    });
    return { ...result, snapshot };
  }

  function handleProxyLogin(event, authInfo, callback) {
    if (!authInfo?.isProxy) return false;
    const snapshot = store.snapshot();
    if (!snapshot.routing.globalEnabled || !snapshot.routing.globalProfileId) return false;
    const secret = store.proxySecret(snapshot.routing.globalProfileId);
    if (!secret || (!secret.username && !secret.password)) return false;
    event.preventDefault();
    callback(secret.username || "", secret.password || "");
    return true;
  }

  return {
    store,
    applyGlobalRouting,
    openProviderLogin,
    probeProviderAccount,
    testProxyProfile,
    handleProxyLogin,
  };
}

module.exports = {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_ANTIGRAVITY_BASE_URL,
  DEFAULT_BYPASS,
  PROVIDER_LOGIN_URLS,
  createProviderNetworkController,
  createProviderNetworkStore,
  normalizeProviderBaseUrl,
  proxyUrl,
  testTcpEndpoint,
};
