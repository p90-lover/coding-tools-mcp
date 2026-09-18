from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    source = path.read_text(encoding="utf-8")
    if new in source:
        return
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {relative}, found {count}: {old[:120]!r}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


adapter_module = r'''"use strict";

const CPA_LOGIN_ADAPTERS = Object.freeze({
  "cpa-codex": Object.freeze({
    id: "cpa-codex",
    kind: "cpa_oauth",
    route: "codex-auth-url",
    providers: Object.freeze(["codex", "openai", "openai-codex"]),
  }),
  "cpa-claude": Object.freeze({
    id: "cpa-claude",
    kind: "cpa_oauth",
    route: "anthropic-auth-url",
    providers: Object.freeze(["anthropic", "claude"]),
  }),
  "cpa-antigravity": Object.freeze({
    id: "cpa-antigravity",
    kind: "cpa_oauth",
    route: "antigravity-auth-url",
    providers: Object.freeze(["antigravity"]),
  }),
  "cpa-gemini": Object.freeze({
    id: "cpa-gemini",
    kind: "cpa_auth_file",
    route: null,
    providers: Object.freeze(["gemini", "gemini-cli", "google-gemini"]),
  }),
});

function adapterDefinition(adapterId) {
  const adapter = CPA_LOGIN_ADAPTERS[String(adapterId || "").trim()];
  if (!adapter) throw new Error(`Unsupported CPA login adapter: ${adapterId || "<missing>"}`);
  return adapter;
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authFileProvider(entry) {
  return String(entry?.provider ?? entry?.type ?? "").trim().toLowerCase();
}

function authFileName(entry) {
  return normalizedText(entry?.name ?? entry?.id);
}

function authFileIndex(entry) {
  return normalizedText(entry?.auth_index ?? entry?.authIndex);
}

function authFileId(entry) {
  return authFileIndex(entry) ?? authFileName(entry);
}

function authFileIdentity(entry) {
  return normalizedText(entry?.email ?? entry?.account ?? entry?.label ?? entry?.username);
}

function authFileDetail(entry) {
  return `${entry?.status ?? ""} ${entry?.status_message ?? ""}`.trim();
}

function connectionStatus(entry) {
  const detail = authFileDetail(entry);
  if (entry?.disabled === true) return "disabled";
  if (/expired|invalid[_ -]?grant|refresh token|reauth/i.test(detail)) return "expired";
  if (entry?.unavailable === true || /error|failed|invalid/i.test(detail)) return "error";
  return "connected";
}

function normalizedAuthFile(entry) {
  const id = authFileId(entry);
  const name = authFileName(entry);
  if (!id || !name) return null;
  return {
    id,
    name,
    authIndex: authFileIndex(entry),
    provider: authFileProvider(entry),
    identity: authFileIdentity(entry),
    status: connectionStatus(entry),
    error: connectionStatus(entry) === "connected" ? null : authFileDetail(entry) || null,
    raw: entry,
  };
}

function adapterFiles(listing, adapter) {
  const files = Array.isArray(listing?.files) ? listing.files : [];
  const providers = new Set(adapter.providers);
  return files
    .map(normalizedAuthFile)
    .filter((entry) => entry && providers.has(entry.provider));
}

function selectAuthFile({
  files,
  boundAuthFileId = null,
  baselineIds = new Set(),
  reservedAuthFileIds = new Set(),
  identity = "",
  requireBound = false,
}) {
  if (boundAuthFileId) {
    const bound = files.find((entry) => entry.id === boundAuthFileId || entry.name === boundAuthFileId);
    if (bound) return bound;
    if (requireBound) throw new Error("The bound CPA account is unavailable; sign in or import it again");
  }
  const available = files.filter((entry) => !reservedAuthFileIds.has(entry.id));
  const created = available.find((entry) => !baselineIds.has(entry.id));
  if (created) return created;
  const normalizedIdentity = String(identity || "").trim().toLowerCase();
  if (normalizedIdentity) {
    const matching = available.find((entry) => (
      String(entry.identity || "").trim().toLowerCase() === normalizedIdentity
    ));
    if (matching) return matching;
  }
  return available.find((entry) => entry.status === "connected")
    ?? available.find((entry) => entry.status !== "disabled")
    ?? available[0]
    ?? null;
}

function modelIds(value) {
  const rows = Array.isArray(value?.models) ? value.models : [];
  return [...new Set(rows.flatMap((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? entry?.model;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort().slice(0, 128);
}

async function resolveAuthFile({
  adapter,
  requestJson,
  baselineIds = new Set(),
  reservedAuthFileIds = new Set(),
  boundAuthFileId = null,
  identity = "",
  requireBound = false,
}) {
  const listing = await requestJson("/v0/management/auth-files");
  const files = adapterFiles(listing, adapter);
  const selected = selectAuthFile({
    files,
    boundAuthFileId,
    baselineIds,
    reservedAuthFileIds,
    identity,
    requireBound,
  });
  if (!selected) {
    const provider = adapter.providers[0];
    throw new Error(`No available ${provider} account exists in CPA; complete its CPA/CLI login first`);
  }
  let models = [];
  let modelError = null;
  try {
    const catalogue = await requestJson(
      `/v0/management/auth-files/models?name=${encodeURIComponent(selected.name)}`,
    );
    models = modelIds(catalogue);
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error);
  }
  return { authFile: selected, models, modelError };
}

async function startCpaAccountLogin({
  adapterId,
  requestJson,
  openExternal,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 1_000,
  identity = "",
  boundAuthFileId = null,
  reservedAuthFileIds = [],
  requireBound = false,
}) {
  if (typeof requestJson !== "function") throw new Error("CPA management request adapter is required");
  const adapter = adapterDefinition(adapterId);
  const reserved = new Set(reservedAuthFileIds.filter(Boolean));
  if (boundAuthFileId) reserved.delete(boundAuthFileId);

  if (adapter.kind === "cpa_auth_file") {
    const resolved = await resolveAuthFile({
      adapter,
      requestJson,
      reservedAuthFileIds: reserved,
      boundAuthFileId,
      identity,
      requireBound,
    });
    return { opened: false, mode: "import", state: null, ...resolved };
  }

  const baselineListing = await requestJson("/v0/management/auth-files");
  const baselineIds = new Set(adapterFiles(baselineListing, adapter).map((entry) => entry.id));
  const login = await requestJson(`/v0/management/${adapter.route}?is_webui=true`);
  const state = normalizedText(login?.state);
  const loginUrl = normalizedText(login?.url);
  if (login?.status !== "ok" || !state || !loginUrl) {
    throw new Error(`CPA did not start ${adapter.providers[0]} authentication`);
  }
  if (typeof openExternal !== "function") throw new Error("CPA OAuth browser opener is unavailable");
  await openExternal(loginUrl);

  const deadline = now() + Math.max(1, timeoutMs);
  while (now() <= deadline) {
    const status = await requestJson(
      `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`,
    );
    if (status?.status === "ok") {
      const resolved = await resolveAuthFile({
        adapter,
        requestJson,
        baselineIds,
        reservedAuthFileIds: reserved,
        boundAuthFileId,
        identity,
        requireBound,
      });
      return { opened: true, mode: "external", state, ...resolved };
    }
    if (status?.status === "error") {
      throw new Error(String(status.error || `${adapter.providers[0]} authentication failed`));
    }
    await sleep(Math.max(1, pollIntervalMs));
  }

  try {
    await requestJson(
      `/v0/management/oauth-session?state=${encodeURIComponent(state)}`,
      { method: "DELETE" },
    );
  } catch {}
  throw new Error(`${adapter.providers[0]} authentication timed out`);
}

async function inspectCpaAccount(options) {
  const adapter = adapterDefinition(options.adapterId);
  const reserved = new Set((options.reservedAuthFileIds ?? []).filter(Boolean));
  if (options.boundAuthFileId) reserved.delete(options.boundAuthFileId);
  const resolved = await resolveAuthFile({
    adapter,
    requestJson: options.requestJson,
    reservedAuthFileIds: reserved,
    boundAuthFileId: options.boundAuthFileId,
    identity: options.identity,
    requireBound: true,
  });
  return { opened: false, mode: "inspect", state: null, ...resolved };
}

module.exports = {
  CPA_LOGIN_ADAPTERS,
  adapterDefinition,
  authFileId,
  authFileIdentity,
  authFileName,
  inspectCpaAccount,
  normalizedAuthFile,
  selectAuthFile,
  startCpaAccountLogin,
};
'''

adapter_path = ROOT / "desktop-electron/electron/cpa-oauth-adapter.cjs"
adapter_path.write_text(adapter_module, encoding="utf-8")

# Provider catalogue: explicit adapter descriptors and first-class Gemini OAuth/CPA import.
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    'export type ProviderLoginMode = "browser" | "antigravity_management" | "commandcode_oauth";\n',
    '''export type ProviderLoginMode = "browser" | "antigravity_management" | "commandcode_oauth";
export type ProviderLoginAdapterKind =
  | "native_browser"
  | "cpa_oauth"
  | "cpa_auth_file"
  | "commandcode_oauth";

export interface ProviderLoginAdapterDefinition {
  id: string;
  kind: ProviderLoginAdapterKind;
  label: string;
  labelTraditionalChinese: string;
  route?: string;
  cpaProvider?: string;
}
''',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '  loginMode?: ProviderLoginMode;\n  subagentEnabled: boolean;\n',
    '  loginMode?: ProviderLoginMode;\n  loginAdapters?: ProviderLoginAdapterDefinition[];\n  subagentEnabled: boolean;\n',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''    models: [],
    proxyMode: "inherit",
    subagentEnabled: true,
''',
    '''    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-codex", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "codex-auth-url", cpaProvider: "codex" },
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
''',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''    models: [],
    proxyMode: "inherit",
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 90,
  },
  {
    id: "chatgpt-web",
''',
    '''    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-claude", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "anthropic-auth-url", cpaProvider: "anthropic" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 90,
  },
  {
    id: "gemini-oauth",
    name: "Gemini OAuth (CPA)",
    category: "oauth",
    auth: "oauth",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-gemini", kind: "cpa_auth_file", label: "Import CPA Gemini account", labelTraditionalChinese: "匯入 CPA Gemini 帳戶", cpaProvider: "gemini" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 78,
  },
  {
    id: "chatgpt-web",
''',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''    models: ["web-gpt"],
    proxyMode: "inherit",
    subagentEnabled: true,
''',
    '''    models: ["web-gpt"],
    proxyMode: "inherit",
    loginAdapters: [
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
''',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''    loginMode: "antigravity_management",
    subagentEnabled: true,
''',
    '''    loginMode: "antigravity_management",
    loginAdapters: [
      { id: "cpa-antigravity", kind: "cpa_oauth", label: "CPA / Antigravity OAuth", labelTraditionalChinese: "CPA／Antigravity OAuth", route: "antigravity-auth-url", cpaProvider: "antigravity" },
    ],
    subagentEnabled: true,
''',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''    loginMode: "commandcode_oauth",
    subagentEnabled: true,
''',
    '''    loginMode: "commandcode_oauth",
    loginAdapters: [
      { id: "commandcode-oauth", kind: "commandcode_oauth", label: "CommandCode OAuth", labelTraditionalChinese: "CommandCode OAuth" },
    ],
    subagentEnabled: true,
''',
)

# Account metadata and typed adapter selection.
replace_once(
    "desktop-electron/src/types.ts",
    'export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";\n',
    '''export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";
export type ProviderCredentialSource = "native_browser" | "cpa" | "commandcode" | "api_key" | "local_proxy";
''',
)
replace_once(
    "desktop-electron/src/types.ts",
    '''  models: string[];
  proxyProfileId?: string;
''',
    '''  models: string[];
  loginAdapterId?: string;
  credentialSource?: ProviderCredentialSource;
  authFileId?: string;
  authFileName?: string;
  proxyProfileId?: string;
''',
)
replace_once(
    "desktop-electron/src/types.ts",
    '''  models?: string[];
  proxyProfileId?: string;
''',
    '''  models?: string[];
  loginAdapterId?: string;
  credentialSource?: ProviderCredentialSource;
  authFileId?: string;
  authFileName?: string;
  proxyProfileId?: string;
''',
)
replace_once(
    "desktop-electron/src/types.ts",
    '''  beginProviderLogin(accountId: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external";
    state?: string;
    snapshot?: ProviderNetworkSnapshot;
  }>;
''',
    '''  beginProviderLogin(accountId: string, adapterId?: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external" | "import";
    state?: string | null;
    adapterId?: string;
    authFileId?: string;
    snapshot?: ProviderNetworkSnapshot;
  }>;
''',
)
replace_once(
    "desktop-electron/electron/preload.cjs",
    '  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),\n',
    '  beginProviderLogin: (accountId, adapterId) => ipcRenderer.invoke("launcher:provider-login", accountId, adapterId),\n',
)
replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''  handle("launcher:provider-login", async (active, _event, accountId) => {
    const result = await active.openProviderLogin(accountId);
''',
    '''  handle("launcher:provider-login", async (active, _event, accountId, adapterId) => {
    const result = await active.openProviderLogin(accountId, adapterId);
''',
)

# Gemini OAuth is first-class in execution routing.
replace_once(
    "desktop-electron/electron/provider-execution-router.cjs",
    '  { id: "gemini-api", name: "Gemini API", protocol: "gemini_native", priority: 75, subagentEnabled: true, paseoEnabled: true, annealEnabled: true },\n',
    '''  { id: "gemini-oauth", name: "Gemini OAuth (CPA)", protocol: "gemini_native", priority: 78, subagentEnabled: true, paseoEnabled: true, annealEnabled: true },
  { id: "gemini-api", name: "Gemini API", protocol: "gemini_native", priority: 75, subagentEnabled: true, paseoEnabled: true, annealEnabled: true },
''',
)

# Provider store and controller integration.
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    'const { writePrivateFileAtomic } = require("./atomic-file.cjs");\n',
    '''const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  CPA_LOGIN_ADAPTERS,
  inspectCpaAccount,
  startCpaAccountLogin,
} = require("./cpa-oauth-adapter.cjs");
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    'const DEFAULT_ANTIGRAVITY_BASE_URL = "http://127.0.0.1:8317";\n',
    'const DEFAULT_ANTIGRAVITY_BASE_URL = "http://127.0.0.1:8317";\nconst DEFAULT_CPA_BASE_URL = DEFAULT_ANTIGRAVITY_BASE_URL;\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''      models: normalizeModels(account.models),
      proxyProfileId: optionalText(account.proxyProfileId, 160),
''',
    '''      models: normalizeModels(account.models),
      loginAdapterId: optionalText(account.loginAdapterId, 160),
      credentialSource: optionalText(account.credentialSource, 64),
      authFileId: optionalText(account.authFileId, 512),
      authFileName: optionalText(account.authFileName, 512),
      proxyProfileId: optionalText(account.proxyProfileId, 160),
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''      models: input.models ?? previous?.models ?? [],
      proxyProfileId: input.proxyProfileId ?? previous?.proxyProfileId,
''',
    '''      models: input.models ?? previous?.models ?? [],
      loginAdapterId: input.loginAdapterId ?? previous?.loginAdapterId,
      credentialSource: input.credentialSource ?? previous?.credentialSource,
      authFileId: input.authFileId ?? previous?.authFileId,
      authFileName: input.authFileName ?? previous?.authFileName,
      proxyProfileId: input.proxyProfileId ?? previous?.proxyProfileId,
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    if (Array.isArray(input.models)) account.models = normalizeModels(input.models).sort();
    account.error = optionalText(input.error, 500);
''',
    '''    if (Array.isArray(input.models)) account.models = normalizeModels(input.models).sort();
    if (Object.hasOwn(input, "loginAdapterId")) account.loginAdapterId = optionalText(input.loginAdapterId, 160);
    if (Object.hasOwn(input, "credentialSource")) account.credentialSource = optionalText(input.credentialSource, 64);
    if (Object.hasOwn(input, "authFileId")) account.authFileId = optionalText(input.authFileId, 512);
    if (Object.hasOwn(input, "authFileName")) account.authFileName = optionalText(input.authFileName, 512);
    account.error = optionalText(input.error, 500);
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '    for (const key of ["antigravityAuthName", "antigravityAuthIndex"]) {\n',
    '''    for (const key of [
      "antigravityAuthName",
      "antigravityAuthIndex",
      "cpaAuthName",
      "cpaAuthIndex",
      "cpaProvider",
      "cpaAdapterId",
    ]) {
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  function antigravityConnection(account) {
    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) throw new Error("Enter the CLIProxyAPI management key before login or testing");
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_ANTIGRAVITY_BASE_URL,
    );
    return { baseUrl, managementKey };
  }
''',
    '''  function cpaConnection(account) {
    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) throw new Error("Enter the CPA / CLIProxyAPI management key before login or testing");
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_CPA_BASE_URL,
    );
    return { baseUrl, managementKey };
  }
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  async function managementJson(account, pathname) {
    const { baseUrl, managementKey } = antigravityConnection(account);
''',
    '''  async function managementJson(account, pathname, { method = "GET" } = {}) {
    const { baseUrl, managementKey } = cpaConnection(account);
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''      const response = await fetchImpl(url.toString(), {
        method: "GET",
''',
    '''      const response = await fetchImpl(url.toString(), {
        method,
''',
)

controller_helpers = r'''
  const PROVIDER_LOGIN_ADAPTERS = Object.freeze({
    "codex-oauth": Object.freeze(["cpa-codex", "native-browser"]),
    "claude-oauth": Object.freeze(["cpa-claude"]),
    "chatgpt-web": Object.freeze(["native-browser"]),
    "gemini-oauth": Object.freeze(["cpa-gemini"]),
    [ANTIGRAVITY_PROVIDER_ID]: Object.freeze(["cpa-antigravity"]),
    [COMMANDCODE_PROVIDER_ID]: Object.freeze(["commandcode-oauth"]),
  });

  function defaultLoginAdapter(account) {
    if (account.loginAdapterId) return account.loginAdapterId;
    if (account.providerId === "codex-oauth") {
      const secret = store.accountSecret(account.id) || {};
      return secret.managementKey || secret.credential ? "cpa-codex" : "native-browser";
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
    return {
      id: account.authFileId
        || String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim()
        || String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim()
        || null,
      name: account.authFileName
        || String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim()
        || null,
    };
  }

  function reservedCpaAuthFileIds(accountId) {
    return store.snapshot().accounts
      .filter((candidate) => candidate.id !== accountId && !candidate.archivedAt)
      .map((candidate) => candidate.authFileId)
      .filter(Boolean);
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
      authFileId: authFile.id,
      authFileName: authFile.name,
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
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
      });
      return {
        opened: result.opened,
        mode: result.mode,
        state: result.state,
        adapterId,
        authFileId: result.authFile.id,
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
    if (!binding.id) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        loginAdapterId: adapterId,
        credentialSource: "cpa",
        models: [],
        error: "No CPA auth file is bound to this account",
      });
    }
    const result = await inspectCpaAccount({
      adapterId,
      requestJson: (pathname, options) => managementJson(account, pathname, options),
      identity: account.identity,
      boundAuthFileId: binding.id,
      reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
    });
    return persistCpaBinding(account, adapterId, result);
  }
'''
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '  async function providerJson(rawUrl, { headers = {}, label = "Provider request" } = {}) {\n',
    controller_helpers + '\n  async function providerJson(rawUrl, { headers = {}, label = "Provider request" } = {}) {\n',
)

old_probe = r'''  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
        return await inspectAntigravitySession(account);
      }
      if (account.providerId === COMMANDCODE_PROVIDER_ID) {
        return await inspectCommandCodeSession(account);
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
'''
new_probe = r'''  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      const adapterId = defaultLoginAdapter(account);
      if (adapterId && CPA_LOGIN_ADAPTERS[adapterId]) {
        return await inspectCpaProviderAccount(account, adapterId);
      }
      if (account.providerId === COMMANDCODE_PROVIDER_ID) {
        return await inspectCommandCodeSession(account);
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
'''
replace_once("desktop-electron/electron/provider-network.cjs", old_probe, new_probe)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '  async function syncBrowserProviderAccount(account) {\n',
    '  async function syncBrowserProviderAccount(account, adapterId = "native-browser") {\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    const snapshot = store.updateAccountConnection(account.id, {
      status: "connected",
      error: undefined,
      models: account.models,
    });
''',
    '''    const snapshot = store.updateAccountConnection(account.id, {
      status: "connected",
      error: undefined,
      models: account.models,
      loginAdapterId: adapterId,
      credentialSource: "native_browser",
      authFileId: undefined,
      authFileName: undefined,
    });
''',
)

start_marker = '  async function openProviderLogin(accountId) {\n'
network_path = ROOT / "desktop-electron/electron/provider-network.cjs"
network_source = network_path.read_text(encoding="utf-8")
start = network_source.find(start_marker)
end = network_source.find('\n  async function testProxyProfile(profileId) {', start)
if start < 0 or end < 0:
    raise SystemExit("openProviderLogin function anchors are missing")
new_login = r'''  async function openProviderLogin(accountId, requestedAdapterId) {
    const account = accountRecord(accountId);
    const adapterId = requiredLoginAdapter(account, requestedAdapterId);
    if (CPA_LOGIN_ADAPTERS[adapterId]) {
      return startCpaProviderLogin(account, adapterId);
    }
    if (adapterId === "native-browser") {
      return syncBrowserProviderAccount(account, adapterId);
    }
    if (adapterId === "commandcode-oauth") {
      const result = await startCommandCodeLogin(account);
      const snapshot = store.updateAccountConnection(account.id, {
        loginAdapterId: adapterId,
        credentialSource: "commandcode",
      });
      return { ...result, adapterId, snapshot };
    }
    throw new Error(`Provider login adapter is not configured: ${adapterId}`);
  }
'''
network_path.write_text(network_source[:start] + new_login + network_source[end:], encoding="utf-8")

# Provider Center adapter-driven UX.
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  PROVIDER_CATALOG,
  type ProviderDefinition,
''',
    '''  PROVIDER_CATALOG,
  type ProviderDefinition,
  type ProviderLoginAdapterDefinition,
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  modelsText: string;
}
''',
    '''  modelsText: string;
  loginAdapterId: string;
}
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  "chatgpt-web": {
''',
    '''  "gemini-oauth": {
    english: "Gemini OAuth (CPA)",
    traditionalChinese: "Gemini OAuth（CPA）",
    descriptionEnglish: "Import a Gemini CLI account already authenticated by CPA without inventing an unsupported OAuth endpoint.",
    descriptionTraditionalChinese: "匯入已由 CPA 驗證的 Gemini CLI 帳戶，不會虛構未支援的 OAuth 端點。",
    aliases: ["gemini oauth", "gemini cli", "cpa gemini"],
  },
  "chatgpt-web": {
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''function supportsProviderLogin(provider: ProviderDefinition): boolean {
  return provider.auth === "oauth"
    || provider.auth === "browser_session"
    || provider.loginMode === "antigravity_management"
    || provider.loginMode === "commandcode_oauth";
}
''',
    '''function supportsProviderLogin(provider: ProviderDefinition): boolean {
  return Array.isArray(provider.loginAdapters) && provider.loginAdapters.length > 0;
}

function loginAdapter(
  provider: ProviderDefinition,
  adapterId: string,
): ProviderLoginAdapterDefinition | undefined {
  return provider.loginAdapters?.find((adapter) => adapter.id === adapterId)
    ?? provider.loginAdapters?.[0];
}

function loginAdapterLabel(language: Language, adapter: ProviderLoginAdapterDefinition): string {
  return text(language, adapter.label, adapter.labelTraditionalChinese);
}
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''    modelsText: provider.models.join("\n"),
  };
}
''',
    '''    modelsText: provider.models.join("\n"),
    loginAdapterId: provider.loginAdapters?.[0]?.id ?? "",
  };
}
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''    modelsText: account.models.join("\n"),
  };
}
''',
    '''    modelsText: account.models.join("\n"),
    loginAdapterId: account.loginAdapterId
      ?? providerDefinition(account.providerId).loginAdapters?.[0]?.id
      ?? "",
  };
}
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const selectedProvider = providerDefinition(selectedProviderId);
  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
''',
    '''  const selectedProvider = providerDefinition(selectedProviderId);
  const selectedLoginAdapter = loginAdapter(selectedProvider, draft.loginAdapterId);
  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                        modelsText: provider.models.join("\n"),
                      }));
''',
    '''                        modelsText: provider.models.join("\n"),
                        loginAdapterId: provider.loginAdapters?.[0]?.id ?? "",
                      }));
''',
)

old_persist = r'''    const models = parseModels(draft.modelsText);
    const provider = providerDefinition(draft.providerId);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const managedLogin = provider.loginMode === "antigravity_management"
      || provider.loginMode === "commandcode_oauth";
    const status = managedLogin
      ? (secret.trim() ? "connected" : draft.status)
      : requiresCredential && secret.trim() ? "connected" : draft.status;
'''
new_persist = r'''    const models = parseModels(draft.modelsText);
    const provider = providerDefinition(draft.providerId);
    const adapter = loginAdapter(provider, draft.loginAdapterId);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const status = adapter
      ? (draft.status === "connected" ? "connected" : "pending")
      : requiresCredential && secret.trim() ? "connected" : draft.status;
'''
replace_once("desktop-electron/src/features/ProviderHubSaasSurface.tsx", old_persist, new_persist)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''      models,
      ...(secret.trim()
''',
    '''      models,
      loginAdapterId: adapter?.id,
      ...(secret.trim()
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''            secret: provider.loginMode === "commandcode_oauth"
              ? {
                  apiKey: secret.trim(),
                  baseUrl: draft.endpoint.trim() || provider.baseUrl || "http://127.0.0.1:9090",
                }
              : { credential: secret.trim() },
''',
    '''            secret: adapter?.kind === "commandcode_oauth"
              ? {
                  apiKey: secret.trim(),
                  baseUrl: draft.endpoint.trim() || provider.baseUrl || "http://127.0.0.1:9090",
                }
              : adapter?.kind === "cpa_oauth" || adapter?.kind === "cpa_auth_file"
                ? {
                    managementKey: secret.trim(),
                    baseUrl: draft.endpoint.trim() || provider.baseUrl || "http://127.0.0.1:8317",
                  }
                : { credential: secret.trim() },
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''      const result = await api.beginProviderLogin(saved.id);
''',
    '''      const adapter = loginAdapter(providerDefinition(saved.providerId), saved.loginAdapterId ?? draft.loginAdapterId);
      if (!adapter) throw new Error(text(language, "Choose a supported login source.", "請選擇受支援的登入來源。"));
      const result = await api.beginProviderLogin(saved.id, adapter.id);
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''        result.snapshot
          ? "The provider session is connected and its model catalogue was refreshed."
          : "The login page opened. Complete the provider sign-in to continue.",
        result.snapshot
          ? "供應商工作階段已連線，模型清單亦已更新。"
          : "登入頁面已開啟。請完成供應商登入以繼續。",
''',
    '''        result.snapshot
          ? (result.mode === "import"
              ? "The CPA account was imported and its model catalogue was refreshed."
              : "The provider session is connected and its model catalogue was refreshed.")
          : "The login page opened. Complete the provider sign-in to continue.",
        result.snapshot
          ? (result.mode === "import"
              ? "CPA 帳戶已匯入，模型清單亦已更新。"
              : "供應商工作階段已連線，模型清單亦已更新。")
          : "登入頁面已開啟。請完成供應商登入以繼續。",
''',
)

login_source_ui = r'''                {selectedProvider.loginAdapters?.length ? (
                  <label>
                    <span>{text(language, "Login source", "登入來源")}</span>
                    <select
                      value={selectedLoginAdapter?.id ?? ""}
                      onChange={(event) => {
                        const adapter = loginAdapter(selectedProvider, event.target.value);
                        setDraft((current) => ({
                          ...current,
                          loginAdapterId: adapter?.id ?? "",
                          status: current.status === "connected" ? "pending" : current.status,
                          endpoint: adapter?.kind === "cpa_oauth" || adapter?.kind === "cpa_auth_file"
                            ? (current.endpoint || selectedProvider.baseUrl || "http://127.0.0.1:8317")
                            : current.endpoint,
                        }));
                        setSecret("");
                      }}
                    >
                      {selectedProvider.loginAdapters.map((adapter) => (
                        <option key={adapter.id} value={adapter.id}>{loginAdapterLabel(language, adapter)}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
'''
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                <label>
                  <span>{text(language, "Connection status", "連線狀態")}</span>
''',
    login_source_ui + '''                <label>
                  <span>{text(language, "Connection status", "連線狀態")}</span>
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                  <span>{selectedProvider.loginMode === "antigravity_management"
                    ? text(language, "CLIProxyAPI management key (encrypted by Electron main process)", "CLIProxyAPI 管理金鑰（由 Electron 主程序加密）")
                    : selectedProvider.loginMode === "commandcode_oauth"
                      ? text(language, "CommandCode API key (or use login/import below)", "CommandCode API Key（或使用下方登入／匯入）")
                      : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
    '''                  <span>{selectedLoginAdapter?.kind === "cpa_oauth" || selectedLoginAdapter?.kind === "cpa_auth_file"
                    ? text(language, "CPA / CLIProxyAPI management key (encrypted)", "CPA／CLIProxyAPI 管理金鑰（已加密）")
                    : selectedLoginAdapter?.kind === "commandcode_oauth"
                      ? text(language, "CommandCode API key (or use login/import below)", "CommandCode API Key（或使用下方登入／匯入）")
                      : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                  {selectedAccount && ["antigravity_management", "commandcode_oauth"].includes(selectedProvider.loginMode ?? "") ? (
''',
    '''                  {selectedAccount && (
                    selectedAccount.loginAdapterId?.startsWith("cpa-")
                    || selectedAccount.loginAdapterId === "commandcode-oauth"
                  ) ? (
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                        : selectedProvider.loginMode === "commandcode_oauth"
                          ? text(language, "Login with CommandCode", "使用 CommandCode 登入")
                          : selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                            ? text(language, "Refresh session", "更新工作階段")
                            : text(language, "Login account", "登入帳戶")}
''',
    '''                        : selectedLoginAdapter?.kind === "commandcode_oauth"
                          ? text(language, "Login with CommandCode", "使用 CommandCode 登入")
                          : selectedLoginAdapter?.kind === "cpa_auth_file"
                            ? text(language, "Import CPA account", "匯入 CPA 帳戶")
                            : selectedLoginAdapter?.kind === "cpa_oauth"
                              ? (selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                                  ? text(language, "Refresh CPA session", "更新 CPA 工作階段")
                                  : text(language, "Login with CPA", "使用 CPA 登入"))
                              : selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                                ? text(language, "Refresh browser session", "更新瀏覽器工作階段")
                                : text(language, "Login account", "登入帳戶")}
''',
)

print("RC9_CPA_UNIFIED_OAUTH_PATCH_OK")
