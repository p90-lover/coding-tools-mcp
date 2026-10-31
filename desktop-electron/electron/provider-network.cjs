const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { readStateFile, writeStateFile } = require("./durable-state.cjs");
const {
  CPA_LOGIN_ADAPTERS,
  inspectCpaAccount,
  startCpaAccountLogin,
} = require("./cpa-oauth-adapter.cjs");
const { fetchDecodoEndpoints, normalizeDecodoSettings } = require("./decodo-proxies.cjs");

const STORE_VERSION = 1;
const ACCOUNT_AUTH = new Set(["oauth", "api_key", "browser_session", "local_proxy"]);
const ACCOUNT_STATUS = new Set(["pending", "connected", "expired", "error", "disabled"]);
const PROXY_PROTOCOLS = new Set(["http", "https", "socks4", "socks5"]);
const PROXY_SCOPES = new Set([
  "all",
  "browser",
  "provider",
  "oauth",
  "subagent",
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
const DEFAULT_CPA_BASE_URL = DEFAULT_ANTIGRAVITY_BASE_URL;
const COMMANDCODE_PROVIDER_ID = "commandcode-proxy";
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
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
    // Decodo's sticky proxy list (decodo-proxies.cjs); its password lives in secrets.decodo.
    decodo: { ...normalizeDecodoSettings(), lastSyncAt: null, lastError: null },
    secrets: {
      accounts: {},
      proxies: {},
      decodo: null,
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
      loginAdapterId: optionalText(account.loginAdapterId, 160),
      credentialSource: optionalText(account.credentialSource, 64),
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
      // Set on a proxy another app owns (ProxyBridge Nova): it is kept in step with that app and
      // only changed there.
      ...(profile.source === "nova" ? { source: "nova", sourceKey: optionalText(profile.sourceKey, 160) } : {}),
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

function normalizeDecodoState(value) {
  let settings;
  try { settings = normalizeDecodoSettings(value && typeof value === "object" ? value : {}); } catch { settings = normalizeDecodoSettings(); }
  return {
    ...settings,
    lastSyncAt: typeof value?.lastSyncAt === "string" ? timestamp(value.lastSyncAt, null) : null,
    lastError: optionalText(value?.lastError, 500) ?? null,
  };
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
    decodo: normalizeDecodoState(parsed.decodo),
    secrets: {
      accounts: secrets.accounts && typeof secrets.accounts === "object" ? secrets.accounts : {},
      proxies: secrets.proxies && typeof secrets.proxies === "object" ? secrets.proxies : {},
      decodo: secrets.decodo && typeof secrets.decodo === "object" ? secrets.decodo : null,
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

function createSecretCodec({ safeStorage, keyPath, canCreateKey }) {
  let fallbackKey = null;

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function loadFallbackKey(create = false) {
    if (fallbackKey) return fallbackKey;
    const read = readStateFile(keyPath, text => {
      const key = Buffer.from(text.trim(), "base64");
      if (key.length !== 32) throw new Error("Invalid encryption key");
      return key;
    }, { preserveUnreadable: true });
    if (read.value) return (fallbackKey = read.value);
    if (read.source !== "none" || !create || !canCreateKey()) {
      throw new Error("Saved encryption key is unavailable; restore it before changing credentials");
    }
    const key = crypto.randomBytes(32);
    writeStateFile(keyPath, `${key.toString("base64")}\n`);
    return (fallbackKey = key);
  }

  function encrypt(value) {
    const plain = JSON.stringify(value);
    if (encryptionAvailable()) {
      return {
        scheme: "electron-safe-storage-v1",
        data: safeStorage.encryptString(plain).toString("base64"),
      };
    }
    const key = loadFallbackKey(true);
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

  function decrypt(envelope, required = false) {
    if (envelope === undefined || envelope === null) return null;
    try {
      let plain;
      if (envelope.scheme === "electron-safe-storage-v1" && encryptionAvailable()) {
        plain = safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
      } else {
        if (envelope.scheme !== "aes-256-gcm-v1") throw new Error("Unsupported saved credential");
        const key = loadFallbackKey();
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        plain = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]).toString("utf8");
      }
      const value = JSON.parse(plain);
      if (required && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid saved credential");
      return value;
    } catch {
      if (required) throw new Error("Saved provider credentials are unavailable; restore them before changing credentials");
      return null;
    }
  }

  return { encrypt, decrypt };
}

function createProviderNetworkStore({ filePath, keyPath, safeStorage }) {
  const readStore = () => readStateFile(filePath, text => {
    const value = JSON.parse(text);
    if (!value || Object.prototype.toString.call(value) !== "[object Object]"
      || value.version !== STORE_VERSION) throw new Error("Invalid provider settings");
    return normalizeState(value);
  }, { preserveUnreadable: true });
  let stateRead = readStore();
  let state = stateRead.value || defaultState();
  function recoverState() {
    if (stateRead.source !== "unreadable") return;
    const read = readStore();
    if (read.value) { stateRead = read; state = read.value; }
  }
  const codec = createSecretCodec({ safeStorage, keyPath,
    canCreateKey: () => stateRead.source !== "unreadable" && ![...Object.values(state.secrets.accounts), ...Object.values(state.secrets.proxies), state.secrets.decodo]
      .some(envelope => envelope?.scheme === "aes-256-gcm-v1"),
  });

  function write() {
    if (stateRead.source === "unreadable") {
      recoverState();
      throw new Error("Saved provider settings were unavailable; retry after restoring or reloading them");
    }
    writeStateFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function publicSnapshot() {
    recoverState();
    return {
      version: STORE_VERSION,
      ...(stateRead.source === "unreadable" ? { error: "Saved provider settings are unavailable; restore them before making changes" } : {}),
      accounts: state.accounts.map((account) => ({
        ...clone(account),
        hasCredential: Boolean(state.secrets.accounts[account.id]),
      })),
      proxyProfiles: state.proxyProfiles.map((profile) => ({ ...clone(profile) })),
      routing: clone(state.routing),
      decodo: { ...clone(state.decodo), hasPassword: Boolean(state.secrets.decodo) },
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
      const previousSecret = codec.decrypt(state.secrets.accounts[id], true) || {};
      state.secrets.accounts[id] = codec.encrypt({
        ...previousSecret,
        ...suppliedSecret,
      });
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
      loginAdapterId: input.loginAdapterId ?? previous?.loginAdapterId,
      credentialSource: input.credentialSource ?? previous?.credentialSource,
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
    if (Object.hasOwn(input, "loginAdapterId")) account.loginAdapterId = optionalText(input.loginAdapterId, 160);
    if (Object.hasOwn(input, "credentialSource")) account.credentialSource = optionalText(input.credentialSource, 64);
    if (input.credentialSource === "cpa" && (account.providerId === COMMANDCODE_PROVIDER_ID || account.providerId === "commandcode-studio")) account.auth = "oauth";
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
    if (previous?.source) throw new Error("This proxy belongs to ProxyBridge Nova; change it on the Proxy page");
    const username = typeof input.username === "string" ? input.username : undefined;
    const password = typeof input.password === "string" ? input.password : undefined;
    if (username !== undefined || password !== undefined) {
      // A field left out keeps the saved one: a new password alone keeps the username, and back.
      const saved = codec.decrypt(state.secrets.proxies[id], true) ?? {};
      state.secrets.proxies[id] = codec.encrypt({
        username: username ?? saved.username ?? "",
        password: password ?? saved.password ?? "",
      });
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
    if (profile.source) throw new Error("This proxy belongs to ProxyBridge Nova; remove it on the Proxy page");
    const now = new Date().toISOString();
    Object.assign(profile, { enabled: false, archivedAt: now, updatedAt: now });
    dropProxyReferences(profileId);
    write();
    return publicSnapshot();
  }

  // Deletes the profile and its stored credentials outright (archiving keeps both).
  function removeProxyProfile(profileId) {
    if (!findProxy(profileId)) return publicSnapshot();
    state.proxyProfiles = state.proxyProfiles.filter((profile) => profile.id !== profileId);
    delete state.secrets.proxies[profileId];
    dropProxyReferences(profileId);
    write();
    return publicSnapshot();
  }

  // Points every route that uses one profile at another (a migration, or a source proxy that went
  // away), keeping each route's mode.
  function moveProxyReferences(fromId, toId) {
    if (state.routing.globalProfileId === fromId) state.routing.globalProfileId = toId;
    state.routing.providers = state.routing.providers.map((policy) => (
      policy.profileId === fromId ? { ...policy, profileId: toId } : policy
    ));
    state.routing.accounts = state.routing.accounts.map((policy) => (
      policy.profileId === fromId ? { ...policy, profileId: toId } : policy
    ));
    for (const account of state.accounts) {
      if (account.proxyProfileId === fromId) account.proxyProfileId = toId;
    }
  }

  /**
   * Makes a source app's proxies the app's own, so they work without that app running: each keeps
   * its id, endpoint, saved credentials and routes, and can be edited here. Nova's own gateway (its
   * gateway profile, and any proxy on that same local port) works only while Nova runs: it is
   * archived and its routes move to the first other adopted proxy. A proxy on another local port
   * belongs to some other program and is kept. Writes only on a change.
   */
  function adoptSourceProfiles(source) {
    if (source !== "nova") throw new Error("Unknown proxy source");
    const owned = state.proxyProfiles.filter((profile) => profile.source === source && !profile.archivedAt);
    if (!owned.length) return { changed: false, snapshot: publicSnapshot() };
    const loopback = (host) => /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(host);
    const gatewayPorts = new Set(owned.filter((profile) => profile.sourceKey === "gateway").map((profile) => profile.endpoint.port));
    const gateway = (profile) => profile.sourceKey === "gateway"
      || (loopback(profile.endpoint.host) && gatewayPorts.has(profile.endpoint.port));
    const fallback = owned.find((profile) => !gateway(profile) && !loopback(profile.endpoint.host))
      ?? owned.find((profile) => !gateway(profile)) ?? null;
    const now = new Date().toISOString();
    for (const profile of owned) {
      const retire = gateway(profile);
      delete profile.source;
      delete profile.sourceKey;
      profile.updatedAt = now;
      if (!retire) continue;
      if (fallback) moveProxyReferences(profile.id, fallback.id);
      else dropProxyReferences(profile.id);
      Object.assign(profile, { enabled: false, archivedAt: now });
    }
    write();
    return { changed: true, snapshot: publicSnapshot() };
  }

  function retargetProxyReferences(fromId, toId) {
    if (!activeProxy(toId)) throw new Error("Proxy profile was not found");
    moveProxyReferences(fromId, toId);
    write();
    return publicSnapshot();
  }

  /**
   * Makes the profiles of one source app match its list: each entry is { id, name, endpoint,
   * username, password, sourceKey }. A source profile the list no longer has is removed, and its
   * routes move to `fallbackId` (when that is in the list) or are dropped. Writes only on a change.
   */
  function syncSourceProfiles(source, entries, { fallbackId = null } = {}) {
    if (source !== "nova") throw new Error("Unknown proxy source");
    const now = new Date().toISOString();
    let changed = false;
    const seen = new Set();
    for (const entry of entries) {
      const index = state.proxyProfiles.findIndex((profile) => profile.id === entry.id);
      const previous = index >= 0 ? state.proxyProfiles[index] : null;
      if (previous && !previous.source) throw new Error(`Proxy profile ${entry.id} is not a ${source} proxy`);
      const credentials = entry.username || entry.password ? { username: entry.username || "", password: entry.password || "" } : null;
      const saved = codec.decrypt(state.secrets.proxies[entry.id]);
      if (JSON.stringify(saved ?? null) !== JSON.stringify(credentials)) {
        if (credentials) state.secrets.proxies[entry.id] = codec.encrypt(credentials);
        else delete state.secrets.proxies[entry.id];
        changed = true;
      }
      const profile = normalizeProxyProfile({
        id: entry.id, name: entry.name, enabled: true, endpoint: entry.endpoint,
        scopes: previous?.scopes ?? ["all"], bypass: previous?.bypass ?? DEFAULT_BYPASS,
        hasAuthentication: Boolean(credentials), createdAt: previous?.createdAt ?? now,
        updatedAt: previous?.updatedAt ?? now, lastCheckedAt: previous?.lastCheckedAt,
        latencyMs: previous?.latencyMs, lastError: previous?.lastError,
        source, sourceKey: entry.sourceKey,
      });
      if (!profile) throw new Error(`Proxy ${entry.name} is invalid`);
      seen.add(profile.id);
      const same = previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...profile, updatedAt: 0 });
      if (same) continue;
      profile.updatedAt = now;
      if (index >= 0) state.proxyProfiles[index] = profile;
      else state.proxyProfiles.push(profile);
      changed = true;
    }
    for (const gone of state.proxyProfiles.filter((profile) => profile.source === source && !seen.has(profile.id))) {
      state.proxyProfiles = state.proxyProfiles.filter((profile) => profile.id !== gone.id);
      delete state.secrets.proxies[gone.id];
      if (fallbackId && seen.has(fallbackId)) moveProxyReferences(gone.id, fallbackId);
      else dropProxyReferences(gone.id);
      changed = true;
    }
    if (changed) write();
    return { changed, snapshot: publicSnapshot() };
  }

  function dropProxyReferences(profileId) {
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
    recoverState();
    return codec.decrypt(state.secrets.accounts[accountId]);
  }

  function mergeAccountSecret(accountId, patch = {}) {
    recoverState();
    const account = findAccount(accountId);
    if (!account || account.archivedAt) throw new Error("Provider account was not found");
    const current = codec.decrypt(state.secrets.accounts[accountId], true) || {};
    for (const key of [
      "antigravityAuthName",
      "antigravityAuthIndex",
      "cpaAuthName",
      "cpaAuthIndex",
      "cpaProvider",
      "cpaAdapterId",
    ]) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = optionalText(patch[key], 512);
      if (value) current[key] = value;
      else delete current[key];
    }
    state.secrets.accounts[accountId] = codec.encrypt(current);
    write();
  }

  function proxySecret(profileId) {
    recoverState();
    return codec.decrypt(state.secrets.proxies[profileId]);
  }

  // Decodo: a password left out keeps the saved one; an empty one clears it.
  function saveDecodoSettings(input = {}) {
    state.decodo = { ...state.decodo, ...normalizeDecodoSettings(input, state.decodo) };
    if (typeof input.password === "string") {
      state.secrets.decodo = input.password ? codec.encrypt({ password: input.password }) : null;
    }
    write();
    return publicSnapshot();
  }

  function decodoSettings() {
    recoverState();
    return { ...clone(state.decodo), password: codec.decrypt(state.secrets.decodo)?.password ?? "" };
  }

  function recordDecodoSync(error = null) {
    state.decodo = { ...state.decodo, lastError: error ? String(error).slice(0, 500) : null,
      ...(error ? {} : { lastSyncAt: new Date().toISOString() }) };
    write();
    return publicSnapshot();
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
    removeProxyProfile,
    retargetProxyReferences,
    syncSourceProfiles,
    adoptSourceProfiles,
    setGlobalRouting,
    setProviderPolicy,
    setAccountPolicy,
    recordProxyHealth,
    accountSecret,
    mergeAccountSecret,
    proxySecret,
    activeProxy,
    saveDecodoSettings,
    decodoSettings,
    recordDecodoSync,
  };
}

function proxyUrl(profile, credentials = null) {
  if (!profile) return null;
  const host = profile.endpoint.host.includes(":")
    ? `[${profile.endpoint.host.replace(/^\[|\]$/g, "")}]`
    : profile.endpoint.host;
  const route = `${profile.endpoint.protocol}://${host}:${profile.endpoint.port}`;
  if (!credentials?.username && !credentials?.password) return route;
  const parsed = new URL(route);
  if (parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase() !== host.replace(/^\[|\]$/g, "").toLowerCase()) {
    throw new Error("Invalid proxy host");
  }
  parsed.username = credentials.username || "";
  parsed.password = credentials.password || "";
  return parsed.toString();
}

// A hostname with several addresses fails with an AggregateError whose message is empty;
// report the per-address codes (for example "EACCES 1.2.3.4") so a blocked or refused
// proxy is diagnosable from the Network Proxy test.
function tcpErrorText(error) {
  if (!(error instanceof Error)) return String(error);
  const attempts = Array.isArray(error.errors)
    ? error.errors.map((item) => [item?.code, item?.address].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  if (attempts.length) return `Connection failed: ${attempts.join(", ")}`;
  return error.message || error.code || "Connection failed";
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
    socket.once("error", (error) => finish({ reachable: false, error: tcpErrorText(error) }));
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

function antigravityAuthIndex(entry) {
  const value = String(entry?.auth_index ?? entry?.authIndex ?? "").trim();
  return value || null;
}

function antigravityIdentity(entry) {
  const value = String(entry?.email ?? entry?.account ?? entry?.label ?? "").trim();
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
  getBrowserProxyBinding = null,
  getCpaConnection = null,
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
  // A profile may need a different env route than its Chromium proxy rule (the built-in
  // gateway's env URL carries its local token). Returns { url, extra } or null.
  let environmentRoute = null;
  if (typeof fetchImpl !== "function") throw new Error("Provider network fetch implementation is unavailable");

  function setEnvironmentRoute(resolver) {
    environmentRoute = typeof resolver === "function" ? resolver : null;
  }

  function clearOwnedEnvironment() {
    for (const name of ownedEnvironment) delete process.env[name];
    ownedEnvironment.clear();
  }

  function setOwnedEnvironment(name, value) {
    process.env[name] = value;
    ownedEnvironment.add(name);
  }

  // The profile's own partition, the Browser tab's active account's (browser-accounts.cjs), and the
  // accounts its Codex threads' turn tabs run on (BrowserHost.livePartitions).
  function liveBrowserPartitions() {
    const host = getBrowserHost?.();
    const hostPartitions = typeof host?.livePartitions === "function" ? host.livePartitions() : [host?.partition];
    return [browserPartition, ...hostPartitions]
      .filter((value, index, list) => typeof value === "string" && list.indexOf(value) === index);
  }

  // The proxy a Browser-tab account is bound to, while it exists and is enabled.
  function boundBrowserProxy(partition) {
    const profileId = getBrowserProxyBinding?.(partition) ?? null;
    return profileId ? store.activeProxy(profileId) : null;
  }

  /** Routes a Browser-tab account's partition: its bound proxy, else Global Routing's, else direct. */
  async function routeBrowserPartition(partition) {
    const target = session.fromPartition(partition);
    const snapshot = store.snapshot();
    const profile = boundBrowserProxy(partition)
      ?? (snapshot.routing.globalEnabled ? store.activeProxy(snapshot.routing.globalProfileId) : null);
    if (!profile) await target.setProxy({ mode: "direct" });
    else await target.setProxy({ mode: "fixed_servers", proxyRules: proxyUrl(profile), proxyBypassRules: profile.bypass.join(",") });
    // Open connections keep the route they were made on; drop them so every request takes this one.
    if (typeof target.closeAllConnections === "function") await target.closeAllConnections().catch(() => {});
    return profile?.id ?? null;
  }

  /** Decodo's sticky proxies become proxy profiles; a later sync updates them in place. */
  async function syncDecodo() {
    const settings = store.decodoSettings();
    try {
      const endpoints = await fetchDecodoEndpoints(settings, settings.password, fetchImpl);
      const existing = new Set(store.snapshot().proxyProfiles.map((profile) => profile.id));
      for (const endpoint of endpoints) store.saveProxyProfile(endpoint);
      const added = endpoints.filter((endpoint) => !existing.has(endpoint.id)).length;
      logger.info("proxy.decodo_synced", { count: endpoints.length, added });
      return { added, updated: endpoints.length - added, snapshot: store.recordDecodoSync(null) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.recordDecodoSync(message);
      logger.warn("proxy.decodo_sync_failed", { message });
      throw error;
    }
  }

  // The variables every program the app starts inherits. Synchronous, so app start sets them before
  // main spawns anything: applied only after the Chromium route's await, AO, the Codex bridge and
  // the MCP tunnel could start in between and run without the proxy until the next restart.
  function applyGlobalEnvironment() {
    const snapshot = store.snapshot();
    const profile = snapshot.routing.globalEnabled
      ? store.activeProxy(snapshot.routing.globalProfileId)
      : null;
    clearOwnedEnvironment();
    if (!profile) return null;
    const special = environmentRoute?.(profile) ?? null;
    // Chromium takes the bare route and answers the proxy's 407 through handleProxyLogin. The
    // programs the app starts (chat agents and every tool they run) read these variables and have
    // no such handler: a bare route to a signed-in proxy (Nova's Decodo profiles, adopted in #655)
    // failed every request of theirs with 407, so the variables carry the saved sign-in, as CPA's do.
    const environmentUrl = special?.url || proxyUrl(profile, store.proxySecret(profile.id));
    setOwnedEnvironment("HTTP_PROXY", environmentUrl);
    setOwnedEnvironment("HTTPS_PROXY", environmentUrl);
    setOwnedEnvironment("ALL_PROXY", environmentUrl);
    // Loopback always stays direct for programs: AO, the bridge and CPA talk to each other on it.
    setOwnedEnvironment("NO_PROXY", [...new Set([...profile.bypass, ...DEFAULT_BYPASS])].join(","));
    // Node ignores the variables above unless this is set; Node programs (MCP servers, CLIs and the
    // tunnel's codex.js) went direct. Node's own proxy support takes HTTP(S) proxies only.
    if (/^https?:/i.test(environmentUrl)) setOwnedEnvironment("NODE_USE_ENV_PROXY", "1");
    for (const [name, value] of Object.entries(special?.extra ?? {})) {
      if (typeof value === "string" && value) setOwnedEnvironment(name, value);
    }
    return profile;
  }

  async function applyGlobalRouting() {
    const snapshot = store.snapshot();
    const profile = applyGlobalEnvironment();
    // The Browser tab's active account may have its own partition (browser-accounts.cjs); one bound
    // to a proxy of its own keeps that proxy (routeBrowserPartition) instead of this route.
    const browserPartitions = liveBrowserPartitions();
    const boundPartitions = browserPartitions.filter((partition) => boundBrowserProxy(partition));
    const targets = [
      session.defaultSession,
      ...browserPartitions.filter((partition) => !boundPartitions.includes(partition))
        .map((partition) => session.fromPartition(partition)),
    ].filter((value, index, list) => value && list.indexOf(value) === index);
    await Promise.all(boundPartitions.map((partition) => routeBrowserPartition(partition)));

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

  function cpaConnection(account) {
    const managed = getCpaConnection?.();
    const managedKey = String(managed?.managementKey || "").trim();
    if (managedKey) {
      return {
        baseUrl: normalizeProviderBaseUrl(managed.baseUrl || DEFAULT_CPA_BASE_URL),
        managementKey: managedKey,
        proxyApiKey: String(managed.proxyApiKey || "").trim(),
      };
    }

    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) {
      throw new Error("Install managed CPA or enter an external CPA / CLIProxyAPI management key before login or testing");
    }
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_CPA_BASE_URL,
    );
    return { baseUrl, managementKey, proxyApiKey: String(secret.apiKey || "").trim() };
  }

  function antigravitySessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    return {
      name: String(secret.antigravityAuthName ?? "").trim() || null,
      authIndex: String(secret.antigravityAuthIndex ?? "").trim() || null,
    };
  }

  async function managementJson(account, pathname, { method = "GET" } = {}) {
    const { baseUrl, managementKey } = cpaConnection(account);
    const url = new URL(pathname, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutMs));
    timeout.unref?.();
    try {
      const response = await fetchImpl(url.toString(), {
        method,
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


  const PROVIDER_LOGIN_ADAPTERS = Object.freeze({
    "codex-oauth": Object.freeze(["cpa-codex", "native-browser"]),
    "claude-oauth": Object.freeze(["cpa-claude"]),
    "chatgpt-web": Object.freeze(["native-browser"]),
    "gemini-oauth": Object.freeze(["cpa-gemini"]),
    [ANTIGRAVITY_PROVIDER_ID]: Object.freeze(["cpa-antigravity"]),
    [COMMANDCODE_PROVIDER_ID]: Object.freeze(["cpa-commandcode-go"]),
    "commandcode-studio": Object.freeze(["cpa-commandcode-studio"]),
  });

  function defaultLoginAdapter(account) {
    if (account.loginAdapterId === "commandcode-oauth" && account.providerId === COMMANDCODE_PROVIDER_ID) return "cpa-commandcode-go";
    if (account.loginAdapterId) return account.loginAdapterId;
    if (account.providerId === "codex-oauth") {
      const managed = getCpaConnection?.();
      const secret = store.accountSecret(account.id) || {};
      return managed?.managementKey || secret.managementKey || secret.credential
        ? "cpa-codex"
        : "native-browser";
    }
    return PROVIDER_LOGIN_ADAPTERS[account.providerId]?.[0] ?? null;
  }

  function requiredLoginAdapter(account, adapterId) {
    const selected = String(adapterId || defaultLoginAdapter(account) || "").trim();
    const allowed = PROVIDER_LOGIN_ADAPTERS[account.providerId] ?? [];
    if (!selected || !allowed.includes(selected)) {
      throw new Error(`Provider login adapter is not configured for ${account.providerId}`);
    }
    return selected;
  }

  function cpaSessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    const authIndex = String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim() || null;
    const name = String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim() || null;
    return {
      id: authIndex || name,
      name,
      authIndex,
    };
  }

  function reservedCpaAuthFileIds(accountId) {
    return store.snapshot().accounts
      .filter((candidate) => candidate.id !== accountId && !candidate.archivedAt)
      .flatMap((candidate) => {
        const secret = store.accountSecret(candidate.id) || {};
        return [
          String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim(),
          String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim(),
        ].filter(Boolean);
      });
  }

  function persistCpaBinding(account, adapterId, result) {
    const authFile = result.authFile;
    store.mergeAccountSecret(account.id, {
      cpaAuthName: authFile.name,
      cpaAuthIndex: authFile.authIndex,
      cpaProvider: authFile.provider,
      cpaAdapterId: adapterId,
      ...(adapterId === "cpa-antigravity" ? {
        antigravityAuthName: authFile.name,
        antigravityAuthIndex: authFile.authIndex,
      } : {}),
    });
    return store.updateAccountConnection(account.id, {
      status: authFile.status,
      identity: authFile.identity ?? account.identity,
      endpoint: cpaConnection(account).baseUrl,
      models: result.models.length > 0 ? result.models : account.models,
      loginAdapterId: adapterId,
      credentialSource: "cpa",
      error: authFile.status === "connected" ? result.modelError : authFile.error,
    });
  }

  async function startCpaProviderLogin(account, adapterId) {
    store.updateAccountConnection(account.id, {
      status: "pending",
      loginAdapterId: adapterId,
      credentialSource: "cpa",
      error: undefined,
    });
    try {
      const binding = cpaSessionBinding(account);
      const result = await startCpaAccountLogin({
        adapterId,
        requestJson: (pathname, options) => managementJson(account, pathname, options),
        openExternal: (url) => shell.openExternal(safeProviderLoginUrl(url)),
        sleep: sleepImpl,
        timeoutMs: oauthTimeoutMs,
        pollIntervalMs: oauthPollIntervalMs,
        identity: account.identity,
        boundAuthFileId: binding.id,
        boundAuthFileName: binding.name,
        boundAuthFileIndex: binding.authIndex,
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
      });
      return {
        opened: result.opened,
        mode: result.mode,
        state: result.state,
        adapterId,
        snapshot: persistCpaBinding(account, adapterId, result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(message),
        loginAdapterId: adapterId,
        credentialSource: "cpa",
        error: message,
      });
      error.snapshot = snapshot;
      throw error;
    }
  }

  async function inspectCpaProviderAccount(account, adapterId) {
    const binding = cpaSessionBinding(account);
    try {
      const result = await inspectCpaAccount({
        adapterId,
        requestJson: (pathname, options) => managementJson(account, pathname, options),
        identity: account.identity,
        boundAuthFileId: binding.id,
        boundAuthFileName: binding.name,
        boundAuthFileIndex: binding.authIndex,
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
        requireBound: Boolean(binding.id),
      });
      if (!binding.id && result.authFile.status !== "connected") {
        return store.updateAccountConnection(account.id, {
          status: result.authFile.status,
          identity: result.authFile.identity ?? account.identity,
          models: result.models,
          loginAdapterId: adapterId,
          credentialSource: "cpa",
          error: result.authFile.error ?? result.modelError,
        });
      }
      return persistCpaBinding(account, adapterId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // cpa-oauth-adapter's resolveAuthFile: "No <provider> account is available in CPA. …"
      if (!binding.id && /No \S+ account is available in CPA/i.test(message)) {
        return store.updateAccountConnection(account.id, {
          status: "pending",
          loginAdapterId: adapterId,
          credentialSource: "cpa",
          models: [],
          error: "No CPA auth file is available for this account",
        });
      }
      if (binding.id && /bound CPA account is unavailable/i.test(message)) {
        return store.updateAccountConnection(account.id, {
          status: "pending",
          loginAdapterId: adapterId,
          credentialSource: "cpa",
          identity: account.identity,
          models: [],
          error: "The bound Antigravity session is unavailable; log in again",
        });
      }
      throw error;
    }
  }

  async function providerJson(rawUrl, { headers = {}, label = "Provider request" } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutMs));
    timeout.unref?.();
    try {
      const response = await fetchImpl(String(rawUrl), {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      });
      let value = {};
      try {
        value = await response.json();
      } catch {
        value = {};
      }
      if (!response.ok) {
        const detail = typeof value?.error === "string"
          ? `: ${value.error.slice(0, 240)}`
          : typeof value?.message === "string"
            ? `: ${value.message.slice(0, 240)}`
            : "";
        throw new Error(`${label} failed (HTTP ${response.status})${detail}`);
      }
      return value;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${label} timed out`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function inspectAntigravitySession(
    account,
    { baselineAuthNames = new Set(), baselineAuthIndexes = new Set() } = {},
  ) {
    const binding = antigravitySessionBinding(account);
    const query = new URLSearchParams();
    if (binding.name) query.set("name", binding.name);
    if (binding.authIndex) query.set("auth_index", binding.authIndex);
    const pathname = query.size > 0
      ? `/v0/management/auth-files?${query.toString()}`
      : "/v0/management/auth-files";
    const listing = await managementJson(account, pathname);
    const files = antigravityAuthFiles(listing);
    if (files.length === 0) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: binding.name || binding.authIndex
          ? "The bound Antigravity session is unavailable; log in again"
          : undefined,
      });
    }

    const exactBound = files.find((entry) => (
      (binding.authIndex && antigravityAuthIndex(entry) === binding.authIndex)
        || (binding.name && antigravityAuthFileName(entry) === binding.name)
    ));
    if ((binding.name || binding.authIndex) && !exactBound) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: "The bound Antigravity session is unavailable; log in again",
      });
    }

    const identity = String(account.identity || "").trim().toLowerCase();
    const newlyCreated = files.find((entry) => {
      const name = antigravityAuthFileName(entry);
      const authIndex = antigravityAuthIndex(entry);
      return (name && !baselineAuthNames.has(name))
        || (authIndex && !baselineAuthIndexes.has(authIndex));
    });
    const selected = exactBound ?? files.find((entry) => {
      const candidate = String(antigravityIdentity(entry) || "").toLowerCase();
      return identity && candidate === identity;
    }) ?? newlyCreated ?? files.find((entry) => {
      const detail = `${entry.status ?? ""} ${entry.status_message ?? ""}`.trim();
      return entry.disabled !== true
        && entry.unavailable !== true
        && providerSessionFailureStatus(detail) !== "expired"
        && !/error|failed|invalid/i.test(detail);
    }) ?? files.find((entry) => entry.disabled !== true) ?? files[0];

    const selectedName = antigravityAuthFileName(selected);
    const selectedAuthIndex = antigravityAuthIndex(selected);
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";

    if (status === "connected") {
      store.mergeAccountSecret(account.id, {
        antigravityAuthName: selectedName,
        antigravityAuthIndex: selectedAuthIndex,
      });
    }

    let models = Array.isArray(account.models) ? account.models : [];
    let modelError;
    if (status === "connected" && selectedName) {
      try {
        const catalogue = await managementJson(
          account,
          `/v0/management/auth-files/models?name=${encodeURIComponent(selectedName)}`,
        );
        const discovered = providerModelIds(catalogue);
        if (discovered.length > 0) models = discovered;
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }

    return store.updateAccountConnection(account.id, {
      status,
      identity: antigravityIdentity(selected) ?? account.identity,
      models,
      error: status === "connected" ? modelError : (selected.status_message || detail || undefined),
    });
  }

  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      const adapterId = defaultLoginAdapter(account);
      if (adapterId && CPA_LOGIN_ADAPTERS[adapterId]) {
        return await inspectCpaProviderAccount(account, adapterId);
      }
      if (adapterId === "native-browser") {
        const browserHost = typeof getBrowserHost === "function" ? getBrowserHost() : null;
        const browser = await browserHost?.probeAuthentication?.();
        return store.updateAccountConnection(account.id, {
          status: browser?.authenticated === true ? "connected" : "pending",
          loginAdapterId: "native-browser",
          credentialSource: "native_browser",
          error: browser?.authenticated === true ? undefined : "Browser session is not authenticated",
        });
      }
      throw new Error("Provider account health probing is not configured for this provider");
    } catch (error) {
      store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function syncBrowserProviderAccount(account, adapterId = "native-browser") {
    const browserHost = typeof getBrowserHost === "function" ? getBrowserHost() : null;
    if (!browserHost || typeof browserHost.openLogin !== "function") {
      throw new Error("Browser provider login is unavailable");
    }
    store.updateAccountConnection(account.id, { status: "pending", error: undefined });
    const browser = await browserHost.openLogin();
    if (!browser || browser.authenticated !== true) {
      const snapshot = store.updateAccountConnection(account.id, {
        status: "pending",
        error: "Complete the ChatGPT sign-in before connecting this provider account",
      });
      const error = new Error("Browser provider login did not establish an authenticated session");
      error.snapshot = snapshot;
      throw error;
    }
    const snapshot = store.updateAccountConnection(account.id, {
      status: "connected",
      error: undefined,
      models: account.models,
      loginAdapterId: adapterId,
      credentialSource: "native_browser",
      authFileId: undefined,
      authFileName: undefined,
    });
    return { opened: true, mode: "embedded", browser, snapshot };
  }

  async function openProviderLogin(accountId, requestedAdapterId) {
    const account = accountRecord(accountId);
    const adapterId = requiredLoginAdapter(account, requestedAdapterId);
    if (CPA_LOGIN_ADAPTERS[adapterId]) {
      return startCpaProviderLogin(account, adapterId);
    }
    if (adapterId === "native-browser") {
      return syncBrowserProviderAccount(account, adapterId);
    }
    throw new Error(`Provider login adapter is not configured: ${adapterId}`);
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

  function handleProxyLogin(event, authInfo, callback, webContents = null) {
    if (!authInfo?.isProxy) return false;
    // A Browser-tab account bound to its own proxy answers with that proxy's sign-in, on its own
    // pages only; it never takes the global route's.
    const asking = webContents?.session;
    const boundPartition = asking ? liveBrowserPartitions().find((partition) => session.fromPartition(partition) === asking) : null;
    const bound = boundPartition ? boundBrowserProxy(boundPartition) : null;
    const snapshot = store.snapshot();
    if (!bound && (!snapshot.routing.globalEnabled || !snapshot.routing.globalProfileId)) return false;
    // Answer only the proxy the route names: anything else on another host or port (a squatter
    // on a loopback port, for one) never receives the saved credentials.
    const profile = bound ?? store.activeProxy(snapshot.routing.globalProfileId);
    const bare = (value) => String(value ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!profile || bare(authInfo.host) !== bare(profile.endpoint.host) || Number(authInfo.port) !== profile.endpoint.port) {
      return false;
    }
    const secret = store.proxySecret(profile.id);
    if (!secret || (!secret.username && !secret.password)) return false;
    event.preventDefault();
    callback(secret.username || "", secret.password || "");
    return true;
  }

  return {
    store,
    applyGlobalEnvironment,
    applyGlobalRouting,
    routeBrowserPartition,
    syncDecodo,
    setEnvironmentRoute,
    openProviderLogin,
    probeProviderAccount,
    testProxyProfile,
    handleProxyLogin,
  };
}

module.exports = {
  tcpErrorText,
  ANTIGRAVITY_PROVIDER_ID,
  COMMANDCODE_PROVIDER_ID,
  DEFAULT_ANTIGRAVITY_BASE_URL,
  DEFAULT_BYPASS,
  PROVIDER_LOGIN_URLS,
  createProviderNetworkController,
  createProviderNetworkStore,
  normalizeProviderBaseUrl,
  proxyUrl,
  testTcpEndpoint,
};
