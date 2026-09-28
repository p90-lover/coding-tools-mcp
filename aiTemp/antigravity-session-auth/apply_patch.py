from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def write(relative: str, text: str) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def replace_once(relative: str, before: str, after: str) -> None:
    text = read(relative)
    if after in text:
        return
    if before not in text:
        raise SystemExit(f"Patch anchor missing in {relative}: {before[:120]!r}")
    write(relative, text.replace(before, after, 1))


# Provider catalogue: declare an explicit login capability instead of inferring it from auth storage.
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    'export type ProxyMode = "inherit" | "direct" | "custom";\n',
    'export type ProxyMode = "inherit" | "direct" | "custom";\n'
    'export type ProviderLoginMode = "browser" | "antigravity_management";\n',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '  modelsEndpoint?: string;\n  paseoEnabled: boolean;\n',
    '  modelsEndpoint?: string;\n  loginMode?: ProviderLoginMode;\n  paseoEnabled: boolean;\n',
)
replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''  {
    id: "cliproxyapi-antigravity",
    name: "CLIProxyAPI / Antigravity",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 40,
  },''',
    '''  {
    id: "cliproxyapi-antigravity",
    name: "CLIProxyAPI / Antigravity",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "custom",
    baseUrl: "http://127.0.0.1:8317",
    modelsEndpoint: "/v0/management/auth-files/models",
    loginMode: "antigravity_management",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 40,
  },''',
)

# Typed renderer boundary: endpoint is public configuration; credentials remain encrypted in main.
replace_once(
    "desktop-electron/src/types.ts",
    '  identity?: string;\n  auth: ProviderAuth;\n',
    '  identity?: string;\n  endpoint?: string;\n  auth: ProviderAuth;\n',
)
replace_once(
    "desktop-electron/src/types.ts",
    '  identity?: string;\n  auth: ProviderAuth;\n  status?: ProviderAccountStatus;\n',
    '  identity?: string;\n  endpoint?: string;\n  auth: ProviderAuth;\n  status?: ProviderAccountStatus;\n',
)
replace_once(
    "desktop-electron/src/types.ts",
    '  beginProviderLogin(accountId: string): Promise<{ opened: boolean; mode: "embedded" | "external" }>;\n',
    '  beginProviderLogin(accountId: string): Promise<{\n'
    '    opened: boolean;\n'
    '    mode: "embedded" | "external";\n'
    '    state?: string;\n'
    '    snapshot?: ProviderNetworkSnapshot;\n'
    '  }>;\n'
    '  probeProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;\n',
)
replace_once(
    "desktop-electron/electron/preload.cjs",
    '  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),\n',
    '  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),\n'
    '  probeProviderAccount: (accountId) => ipcRenderer.invoke("launcher:provider-account-probe", accountId),\n',
)

# Main-process provider store and CLIProxyAPI management client.
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''const PROVIDER_LOGIN_URLS = Object.freeze({
  "codex-oauth": "https://chatgpt.com/",
  "chatgpt-web": "https://chatgpt.com/",
  "claude-oauth": "https://claude.ai/login",
  "ai-studio-reverse-proxy": "https://aistudio.google.com/",
  "gemini-reverse-proxy": "https://aistudio.google.com/",
});
''',
    '''const PROVIDER_LOGIN_URLS = Object.freeze({
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
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '      identity: optionalText(account.identity, 320),\n      auth,\n',
    '      identity: optionalText(account.identity, 320),\n      endpoint: optionalText(account.endpoint, 2_048),\n      auth,\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '      identity: input.identity,\n      auth,\n',
    '      identity: input.identity,\n      endpoint: input.endpoint ?? previous?.endpoint,\n      auth,\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  function saveProxyProfile(input) {
''',
    '''  function updateAccountConnection(accountId, input = {}) {
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
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    archiveAccount,
    saveProxyProfile,
''',
    '''    archiveAccount,
    updateAccountConnection,
    saveProxyProfile,
''',
)

provider_helpers = r'''
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

'''
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    'function createProviderNetworkController({\n',
    provider_helpers + 'function createProviderNetworkController({\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  shell,
  userData,
}) {
''',
    '''  shell,
  userData,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  oauthPollIntervalMs = DEFAULT_OAUTH_POLL_INTERVAL_MS,
  oauthTimeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
}) {
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  const ownedEnvironment = new Set();

  function clearOwnedEnvironment() {
''',
    '''  const ownedEnvironment = new Set();
  if (typeof fetchImpl !== "function") throw new Error("Provider network fetch implementation is unavailable");

  function clearOwnedEnvironment() {
''',
)

old_login = '''  async function openProviderLogin(accountId) {
    const snapshot = store.snapshot();
    const account = snapshot.accounts.find((item) => item.id === accountId && !item.archivedAt);
    if (!account) throw new Error("Provider account was not found");
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: "embedded", browser: browser || null };
    }
    const url = PROVIDER_LOGIN_URLS[account.providerId];
    if (!url) throw new Error("This provider uses API key or custom endpoint authentication");
    await shell.openExternal(url);
    return { opened: true, mode: "external" };
  }
'''
new_login = r'''  function accountRecord(accountId) {
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

  async function inspectAntigravitySession(account) {
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
    const selected = files.find((entry) => {
      const candidate = String(entry.email ?? entry.label ?? "").trim().toLowerCase();
      return identity && candidate === identity;
    }) ?? files.find((entry) => entry.disabled !== true) ?? files[0];
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (selected.unavailable === true || providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (/error|failed|invalid/i.test(detail)) status = "error";

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
            snapshot: await inspectAntigravitySession(accountRecord(account.id)),
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
'''
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    old_login,
    new_login,
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    openProviderLogin,
    testProxyProfile,
''',
    '''    openProviderLogin,
    probeProviderAccount,
    testProxyProfile,
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''module.exports = {
  DEFAULT_BYPASS,
  PROVIDER_LOGIN_URLS,
''',
    '''module.exports = {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_ANTIGRAVITY_BASE_URL,
  DEFAULT_BYPASS,
  PROVIDER_LOGIN_URLS,
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  createProviderNetworkStore,
  proxyUrl,
''',
    '''  createProviderNetworkStore,
  normalizeProviderBaseUrl,
  proxyUrl,
''',
)

# IPC must call the controller rather than reimplementing static URLs.
replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''const {
  PROVIDER_LOGIN_URLS,
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
''',
    '''const {
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
''',
)
replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''  handle("launcher:provider-login", async (active, _event, accountId) => {
    const account = active.store.snapshot().accounts.find((item) => (
      item.id === accountId && !item.archivedAt
    ));
    if (!account) throw new Error("Provider account was not found");
    const externalUrl = PROVIDER_LOGIN_URLS[account.providerId];
    if (!externalUrl) {
      throw new Error("This provider uses API key or custom endpoint authentication");
    }
    await shell.openExternal(externalUrl);
    return { opened: true, mode: "external" };
  });
''',
    '''  handle("launcher:provider-login", async (active, _event, accountId) => {
    const result = await active.openProviderLogin(accountId);
    if (result?.snapshot) publish(result.snapshot);
    return result;
  });
  handle("launcher:provider-account-probe", async (active, _event, accountId) => (
    publish(await active.probeProviderAccount(accountId))
  ));
''',
)

# Active Provider Hub UI.
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '  identity: string;\n  auth: ProviderAuth;\n',
    '  identity: string;\n  endpoint: string;\n  auth: ProviderAuth;\n',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''function providerDefinition(providerId: string): ProviderDefinition {
  return PROVIDER_CATALOG.find((candidate) => candidate.id === providerId)
    ?? PROVIDER_CATALOG[0];
}
''',
    '''function providerDefinition(providerId: string): ProviderDefinition {
  return PROVIDER_CATALOG.find((candidate) => candidate.id === providerId)
    ?? PROVIDER_CATALOG[0];
}

function supportsProviderLogin(provider: ProviderDefinition): boolean {
  return provider.auth === "oauth"
    || provider.auth === "browser_session"
    || provider.loginMode === "antigravity_management";
}
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '    identity: "",\n    auth: provider.auth,\n',
    '    identity: "",\n    endpoint: provider.baseUrl ?? "",\n    auth: provider.auth,\n',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '    identity: account.identity ?? "",\n    auth: account.auth,\n',
    '    identity: account.identity ?? "",\n    endpoint: account.endpoint ?? providerDefinition(account.providerId).baseUrl ?? "",\n    auth: account.auth,\n',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''    const models = parseModels(draft.modelsText);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const status = requiresCredential && secret.trim() ? "connected" : draft.status;
    const input: ProviderAccountInput = {
''',
    '''    const models = parseModels(draft.modelsText);
    const provider = providerDefinition(draft.providerId);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const status = provider.loginMode === "antigravity_management"
      ? draft.status
      : requiresCredential && secret.trim() ? "connected" : draft.status;
    const input: ProviderAccountInput = {
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '      identity: draft.identity.trim() || undefined,\n      auth: draft.auth,\n',
    '      identity: draft.identity.trim() || undefined,\n      endpoint: draft.endpoint.trim() || undefined,\n      auth: draft.auth,\n',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''      const saved = await persistAccount();
      await api.beginProviderLogin(saved.id);
      setNotice(text(
        language,
        "The login page opened. Return here after sign-in and set the account status to Connected.",
        "登入頁面已開啟。完成登入後返回此處，並將帳戶狀態設為「已連線」。",
      ));
''',
    '''      const saved = await persistAccount();
      const result = await api.beginProviderLogin(saved.id);
      if (result.snapshot) adoptSnapshot(result.snapshot, saved.id);
      setNotice(text(
        language,
        result.snapshot
          ? "The provider session is connected and its model catalogue was refreshed."
          : "The login page opened. Complete the provider sign-in to continue.",
        result.snapshot
          ? "供應商工作階段已連線，模型清單亦已更新。"
          : "登入頁面已開啟。請完成供應商登入以繼續。",
      ));
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const setDefaultAccount = async () => {
''',
    '''  const testProviderConnection = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedAccount) return;
    setBusy("provider-probe");
    setError(null);
    try {
      const next = await api.probeProviderAccount(selectedAccount.id);
      adoptSnapshot(next, selectedAccount.id);
      const probed = next.accounts.find((account) => account.id === selectedAccount.id);
      setNotice(probed?.status === "connected"
        ? text(language, "Connection succeeded and models were refreshed.", "連線成功，模型清單已更新。")
        : text(language, "Provider session is not connected yet.", "供應商工作階段尚未連線。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const setDefaultAccount = async () => {
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                        auth: provider.auth,
                        label: provider.name,
                        modelsText: provider.models.join("\\n"),
''',
    '''                        auth: provider.auth,
                        label: provider.name,
                        endpoint: provider.baseUrl ?? "",
                        modelsText: provider.models.join("\\n"),
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                <label className="provider-full-row">
                  <span>{text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
    '''                <label className="provider-full-row">
                  <span>{text(language, "Provider / management endpoint", "供應商／管理端點")}</span>
                  <input
                    placeholder={selectedProvider.baseUrl ?? "https://…"}
                    value={draft.endpoint}
                    onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
                  />
                </label>
                <label className="provider-full-row">
                  <span>{selectedProvider.loginMode === "antigravity_management"
                    ? text(language, "CLIProxyAPI management key (encrypted by Electron main process)", "CLIProxyAPI 管理金鑰（由 Electron 主程序加密）")
                    : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                  {(draft.auth === "oauth" || draft.auth === "browser_session") ? (
                    <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void openLogin()} type="button">
                      {busy === "provider-login" ? "…" : text(language, "Login account", "登入帳戶")}
                    </button>
                  ) : null}
''',
    '''                  {selectedAccount && selectedProvider.loginMode === "antigravity_management" ? (
                    <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void testProviderConnection()} type="button">
                      {busy === "provider-probe" ? "…" : text(language, "Test connection", "測試連線")}
                    </button>
                  ) : null}
                  {supportsProviderLogin(selectedProvider) ? (
                    <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void openLogin()} type="button">
                      {busy === "provider-login"
                        ? "…"
                        : selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                          ? text(language, "Refresh session", "更新工作階段")
                          : text(language, "Login account", "登入帳戶")}
                    </button>
                  ) : null}
''',
)

print("ANTIGRAVITY_SESSION_PATCH_APPLIED")
