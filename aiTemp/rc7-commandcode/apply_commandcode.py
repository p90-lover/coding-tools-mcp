from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, before: str, after: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"expected one anchor in {relative}, found {count}: {before[:140]!r}")
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {relative}")


replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    'export type ProviderLoginMode = "browser" | "antigravity_management";\n',
    'export type ProviderLoginMode = "browser" | "antigravity_management" | "commandcode_oauth";\n',
)

replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    '''  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
  },
''',
    '''  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "custom",
    baseUrl: "http://127.0.0.1:9090",
    modelsEndpoint: "/v1/models",
    loginMode: "commandcode_oauth",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
  },
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
''',
    '''const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''const ANTIGRAVITY_PROVIDER_ID = "cliproxyapi-antigravity";
const DEFAULT_ANTIGRAVITY_BASE_URL = "http://127.0.0.1:8317";
''',
    '''const ANTIGRAVITY_PROVIDER_ID = "cliproxyapi-antigravity";
const DEFAULT_ANTIGRAVITY_BASE_URL = "http://127.0.0.1:8317";
const COMMANDCODE_PROVIDER_ID = "commandcode-proxy";
const DEFAULT_COMMANDCODE_PROXY_URL = "http://127.0.0.1:9090";
const COMMANDCODE_API_URL = "https://api.commandcode.ai";
const COMMANDCODE_LOGIN_URL = "https://commandcode.ai/studio/auth/cli";
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''function providerModelIds(value) {
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
''',
    '''function providerModelIds(value) {
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

function commandCodeAuthFilePath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".commandcode", "auth.json");
}

function commandCodeToken(value) {
  const roots = [value, value?.auth, value?.data].filter((candidate) => (
    candidate && typeof candidate === "object"
  ));
  for (const root of roots) {
    for (const key of ["apiKey", "api_key", "token", "credential", "key"]) {
      const candidate = root[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return "";
}

function commandCodeModelIds(value) {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : Array.isArray(value?.models)
        ? value.models
        : [];
  return [...new Set(rows.flatMap((entry) => {
    const id = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? (entry.id ?? entry.name ?? entry.model)
        : null;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort().slice(0, 128);
}

function commandCodeIdentity(value) {
  for (const candidate of [value?.email, value?.user?.email, value?.username, value?.id, value?.user?.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  userData,
  fetchImpl = globalThis.fetch,
''',
    '''  userData,
  homeDirectory = os.homedir(),
  fetchImpl = globalThis.fetch,
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  async function inspectAntigravitySession(account, { baselineAuthNames = new Set() } = {}) {
''',
    '''  async function providerJson(rawUrl, { headers = {}, label = "Provider request" } = {}) {
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

  async function inspectAntigravitySession(account, { baselineAuthNames = new Set() } = {}) {
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  async function probeProviderAccount(accountId) {
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
''',
    '''  function commandCodeConnection(account) {
    const secret = store.accountSecret(account.id) || {};
    const apiKey = commandCodeToken(secret);
    if (!apiKey) throw new Error("Login with CommandCode or import ~/.commandcode/auth.json first");
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_COMMANDCODE_PROXY_URL,
    );
    return { apiKey, baseUrl };
  }

  function commandCodeHeaders(apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "cli",
      "x-cli-environment": "cli",
      "x-command-code-version": "coding-tools-rc7",
    };
  }

  async function inspectCommandCodeSession(account) {
    const { apiKey, baseUrl } = commandCodeConnection(account);
    const headers = commandCodeHeaders(apiKey);
    const identityPayload = await providerJson(
      `${COMMANDCODE_API_URL}/alpha/whoami`,
      { headers, label: "CommandCode session probe" },
    );

    let models = [];
    let modelError;
    try {
      const catalogue = await providerJson(
        new URL("/v1/models", `${baseUrl}/`).toString(),
        { headers, label: "CommandCode reverse-proxy model discovery" },
      );
      models = commandCodeModelIds(catalogue);
    } catch (localError) {
      try {
        const catalogue = await providerJson(
          `${COMMANDCODE_API_URL}/provider/v1/models`,
          { headers, label: "CommandCode model discovery" },
        );
        models = commandCodeModelIds(catalogue);
      } catch (remoteError) {
        modelError = remoteError instanceof Error
          ? remoteError.message
          : String(remoteError || localError);
      }
    }

    return store.updateAccountConnection(account.id, {
      status: "connected",
      identity: commandCodeIdentity(identityPayload) ?? account.identity,
      endpoint: baseUrl,
      models: models.length > 0 ? models : account.models,
      error: modelError,
    });
  }

  async function importProviderSession(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId !== COMMANDCODE_PROVIDER_ID) {
      throw new Error("Session import is only configured for CommandCode Proxy");
    }
    const authPath = commandCodeAuthFilePath(homeDirectory);
    let stat;
    try {
      stat = fs.lstatSync(authPath);
    } catch {
      throw new Error(`CommandCode CLI session was not found at ${authPath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024) {
      throw new Error("CommandCode CLI session file is unsafe or invalid");
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    } catch {
      throw new Error("CommandCode CLI session file is not valid JSON");
    }
    const apiKey = commandCodeToken(parsed);
    if (!apiKey) throw new Error("CommandCode CLI session does not contain an API key");
    const baseUrl = account.endpoint || DEFAULT_COMMANDCODE_PROXY_URL;
    store.saveAccount({
      ...account,
      status: "pending",
      secret: { apiKey, baseUrl },
    });
    return inspectCommandCodeSession(accountRecord(account.id));
  }

  async function commandCodeCallbackPayload(request, callbackBase) {
    const requestUrl = new URL(request.url || "/", callbackBase);
    const values = Object.fromEntries(requestUrl.searchParams.entries());
    if (request.method !== "GET" && request.method !== "HEAD") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("CommandCode login callback is too large");
        chunks.push(chunk);
      }
      if (chunks.length > 0) {
        const text = Buffer.concat(chunks).toString("utf8");
        const contentType = String(request.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("application/json")) {
          Object.assign(values, JSON.parse(text));
        } else {
          Object.assign(values, Object.fromEntries(new URLSearchParams(text).entries()));
        }
      }
    }
    return values;
  }

  async function startCommandCodeLogin(account) {
    const state = crypto.randomBytes(24).toString("hex");
    let settleCallback;
    let rejectCallback;
    const callback = new Promise((resolve, reject) => {
      settleCallback = resolve;
      rejectCallback = reject;
    });
    const server = http.createServer(async (request, response) => {
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("CommandCode callback server is unavailable");
        const callbackBase = `http://127.0.0.1:${address.port}`;
        const url = new URL(request.url || "/", callbackBase);
        if (url.pathname !== "/commandcode/callback") {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        const values = await commandCodeCallbackPayload(request, callbackBase);
        if (String(values.state || "") !== state) throw new Error("CommandCode login state did not match");
        const apiKey = commandCodeToken(values);
        if (!apiKey) throw new Error("CommandCode login did not return an API key");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>CommandCode connected</title><h1>CommandCode connected</h1><p>You can close this window and return to Coding Tools.</p>");
        settleCallback(apiKey);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("CommandCode login failed. Return to Coding Tools for details.");
        rejectCallback(error);
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("CommandCode callback server did not start");
    }
    const callbackUrl = `http://127.0.0.1:${address.port}/commandcode/callback`;
    const loginUrl = new URL(COMMANDCODE_LOGIN_URL);
    loginUrl.searchParams.set("callback", callbackUrl);
    loginUrl.searchParams.set("state", state);
    store.updateAccountConnection(account.id, { status: "pending", error: undefined });

    let timer;
    try {
      await shell.openExternal(safeProviderLoginUrl(loginUrl.toString()));
      const apiKey = await Promise.race([
        callback,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("CommandCode authentication timed out")),
            Math.max(1, oauthTimeoutMs),
          );
          timer.unref?.();
        }),
      ]);
      const baseUrl = account.endpoint || DEFAULT_COMMANDCODE_PROXY_URL;
      store.saveAccount({
        ...account,
        status: "pending",
        secret: { apiKey, baseUrl },
      });
      return {
        opened: true,
        mode: "external",
        state,
        snapshot: await inspectCommandCodeSession(accountRecord(account.id)),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(message),
        error: message,
      });
      error.snapshot = snapshot;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function probeProviderAccount(accountId) {
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
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
    '''    if (account.providerId === COMMANDCODE_PROVIDER_ID) {
      return startCommandCodeLogin(account);
    }
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    openProviderLogin,
    probeProviderAccount,
''',
    '''    openProviderLogin,
    importProviderSession,
    probeProviderAccount,
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''module.exports = {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_ANTIGRAVITY_BASE_URL,
''',
    '''module.exports = {
  ANTIGRAVITY_PROVIDER_ID,
  COMMANDCODE_PROVIDER_ID,
  DEFAULT_ANTIGRAVITY_BASE_URL,
  DEFAULT_COMMANDCODE_PROXY_URL,
  commandCodeAuthFilePath,
  commandCodeModelIds,
  commandCodeToken,
''',
)

replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''  handle("launcher:provider-account-probe", async (active, _event, accountId) => (
    publish(await active.probeProviderAccount(accountId))
  ));
''',
    '''  handle("launcher:provider-account-probe", async (active, _event, accountId) => (
    publish(await active.probeProviderAccount(accountId))
  ));
  handle("launcher:provider-session-import", async (active, _event, accountId) => (
    publish(await active.importProviderSession(accountId))
  ));
''',
)

replace_once(
    "desktop-electron/electron/preload.cjs",
    '''  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),
  probeProviderAccount: (accountId) => ipcRenderer.invoke("launcher:provider-account-probe", accountId),
''',
    '''  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),
  importProviderSession: (accountId) => ipcRenderer.invoke("launcher:provider-session-import", accountId),
  probeProviderAccount: (accountId) => ipcRenderer.invoke("launcher:provider-account-probe", accountId),
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  }>;
  probeProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
''',
    '''  }>;
  importProviderSession(accountId: string): Promise<ProviderNetworkSnapshot>;
  probeProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  return provider.auth === "oauth"
    || provider.auth === "browser_session"
    || provider.loginMode === "antigravity_management";
''',
    '''  return provider.auth === "oauth"
    || provider.auth === "browser_session"
    || provider.loginMode === "antigravity_management"
    || provider.loginMode === "commandcode_oauth";
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const connectedAccounts = useMemo(
    () => activeAccounts.filter((account) => account.enabled && account.status === "connected"),
    [activeAccounts],
  );
''',
    '''  const connectedAccounts = useMemo(
    () => activeAccounts.filter((account) => account.enabled && account.status === "connected"),
    [activeAccounts],
  );

  const accountValidation = useMemo(() => {
    if (!draft.providerId) return text(language, "Choose a provider.", "請選擇供應商。");
    if (!draft.label.trim()) return text(language, "Account label is required.", "必須填寫帳戶名稱。");
    if (draft.endpoint.trim()) {
      try {
        const endpoint = new URL(draft.endpoint.trim());
        const loopback = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
          || endpoint.hostname.startsWith("127.");
        if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
          return text(
            language,
            "Provider endpoint requires HTTPS; HTTP is only allowed on loopback.",
            "供應商端點必須使用 HTTPS；HTTP 只允許本機 Loopback。",
          );
        }
      } catch {
        return text(language, "Provider endpoint is invalid.", "供應商端點無效。");
      }
    }
    return "";
  }, [draft.endpoint, draft.label, draft.providerId, language]);

  const routingRequirements = useMemo(() => {
    if (!selectedAccount) return text(language, "Save an account before configuring task routing.", "請先儲存帳戶，再設定任務路由。");
    if (!workspaceId) return text(language, "Choose a workspace to configure routing.", "請選擇工作區以設定路由。");
    if (!selectedAccount.enabled || selectedAccount.status !== "connected") {
      return text(language, "The account must be enabled and connected before routing.", "帳戶必須已啟用並已連線，先可以設定路由。");
    }
    if (!(selectedModel.trim() || selectedAccount.models[0])) {
      return text(language, "Choose or enter a task model.", "請選擇或輸入任務模型。");
    }
    if (workload === "anneal" && (!projectId.trim() || !repoId.trim() || !assigneeId.trim())) {
      return text(
        language,
        "Anneal routing requires project, repository and assigned-agent IDs.",
        "Anneal 路由需要專案、儲存庫及獲指派代理 ID。",
      );
    }
    return "";
  }, [assigneeId, language, projectId, repoId, selectedAccount, selectedModel, workload, workspaceId]);
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''    if (!api) throw new Error(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商樞紐。"));
    if (!draft.label.trim()) throw new Error(text(language, "Account label is required.", "必須填寫帳戶名稱。"));
''',
    '''    if (!api) throw new Error(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商樞紐。"));
    if (accountValidation) throw new Error(accountValidation);
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''    const status = provider.loginMode === "antigravity_management"
      ? draft.status
      : requiresCredential && secret.trim() ? "connected" : draft.status;
''',
    '''    const managedLogin = provider.loginMode === "antigravity_management"
      || provider.loginMode === "commandcode_oauth";
    const status = managedLogin
      ? (secret.trim() ? "connected" : draft.status)
      : requiresCredential && secret.trim() ? "connected" : draft.status;
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''      ...(secret.trim() ? { secret: { credential: secret.trim() } } : {}),
''',
    '''      ...(secret.trim()
        ? {
            secret: provider.loginMode === "commandcode_oauth"
              ? {
                  apiKey: secret.trim(),
                  baseUrl: draft.endpoint.trim() || provider.baseUrl || "http://127.0.0.1:9090",
                }
              : { credential: secret.trim() },
          }
        : {}),
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const testProviderConnection = async () => {
''',
    '''  const importCommandCodeSession = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setBusy("provider-import");
    setError(null);
    try {
      const saved = selectedAccount ?? await persistAccount();
      const next = await api.importProviderSession(saved.id);
      adoptSnapshot(next, saved.id);
      setNotice(text(
        language,
        "CommandCode CLI session imported; identity and models were refreshed.",
        "已匯入 CommandCode CLI 工作階段；身份及模型清單已更新。",
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const testProviderConnection = async () => {
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                  <span>{selectedProvider.loginMode === "antigravity_management"
                    ? text(language, "CLIProxyAPI management key (encrypted by Electron main process)", "CLIProxyAPI 管理金鑰（由 Electron 主程序加密）")
                    : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
    '''                  <span>{selectedProvider.loginMode === "antigravity_management"
                    ? text(language, "CLIProxyAPI management key (encrypted by Electron main process)", "CLIProxyAPI 管理金鑰（由 Electron 主程序加密）")
                    : selectedProvider.loginMode === "commandcode_oauth"
                      ? text(language, "CommandCode API key (or use login/import below)", "CommandCode API Key（或使用下方登入／匯入）")
                      : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''              <div className="provider-editor-actions">
''',
    '''              {accountValidation ? (
                <p className="provider-account-inline-error" role="alert">{accountValidation}</p>
              ) : null}

              <div className="provider-editor-actions">
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
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
                  <button className="provider-primary-button" disabled={busy !== null} onClick={() => void saveAccount()} type="button">
''',
    '''                  {selectedAccount && ["antigravity_management", "commandcode_oauth"].includes(selectedProvider.loginMode ?? "") ? (
                    <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void testProviderConnection()} type="button">
                      {busy === "provider-probe" ? "…" : text(language, "Test reverse proxy", "測試反向代理")}
                    </button>
                  ) : null}
                  {selectedProvider.loginMode === "commandcode_oauth" ? (
                    <button className="provider-secondary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void importCommandCodeSession()} type="button">
                      {busy === "provider-import"
                        ? "…"
                        : text(language, "Import CommandCode CLI session", "匯入 CommandCode CLI 工作階段")}
                    </button>
                  ) : null}
                  {supportsProviderLogin(selectedProvider) ? (
                    <button className="provider-secondary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void openLogin()} type="button">
                      {busy === "provider-login"
                        ? "…"
                        : selectedProvider.loginMode === "commandcode_oauth"
                          ? text(language, "Login with CommandCode", "使用 CommandCode 登入")
                          : selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                            ? text(language, "Refresh session", "更新工作階段")
                            : text(language, "Login account", "登入帳戶")}
                    </button>
                  ) : null}
                  <button className="provider-primary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void saveAccount()} type="button">
''',
)

replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                  <div className="provider-routing-actions">
                    <button
                      className="provider-primary-button"
                      disabled={busy !== null || !workspaceId}
''',
    '''                  {routingRequirements ? (
                    <p className="provider-account-inline-error" role="status">{routingRequirements}</p>
                  ) : null}
                  <div className="provider-routing-actions">
                    <button
                      className="provider-primary-button"
                      disabled={busy !== null || Boolean(routingRequirements)}
''',
)

css_path = ROOT / "desktop-electron/src/features/provider-hub-saas.css"
css = css_path.read_text(encoding="utf-8")
css_block = '''
.provider-account-inline-error {
  border: 1px solid color-mix(in srgb, #ff6b75 45%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, #ff6b75 10%, transparent);
  color: #ffb3b9;
  font-size: 12px;
  line-height: 1.45;
  margin: 12px 0 0;
  padding: 10px 12px;
}
'''
if ".provider-account-inline-error" not in css:
    css_path.write_text(css.rstrip() + "\n" + css_block, encoding="utf-8")
    print("patched: desktop-electron/src/features/provider-hub-saas.css")

print("RC7_COMMANDCODE_PATCH_APPLIED")
