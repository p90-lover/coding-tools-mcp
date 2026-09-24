import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PROVIDER_CATALOG } from "./provider-types";
import { ProviderCenterSurface } from "../features/ProviderHubSaasSurface";
import { Icon } from "../icons";
import type {
  Language,
  ProviderAccountRecord,
  ProviderNetworkSnapshot,
  ProxyPolicyMode,
  ProxyProfileInput,
  ProxyProfileRecord,
  ProxyProtocol,
  ProxyScope,
} from "../types";
import "./provider-manager.css";

const api = window.codexWebLauncher;

type ProviderLocale = "en" | "zh-TW";
type ManagerView = "console" | "routing" | "proxies";

function providerLocale(language: Language | null): ProviderLocale {
  return language === "zh-TW" || language === "zh-CN" ? "zh-TW" : "en";
}

const COPY = {
  en: {
    navigationGroup: "Connections",
    navigationLabel: "Providers",
    title: "Providers",
    subtitle: "Connect provider accounts, verify each connection, and decide how their traffic is routed — one console, no separate server.",
    console: "Connections",
    consoleBody: "Accounts, credentials and connection health per provider.",
    routing: "Routing",
    routingBody: "Per-provider and per-account proxy routes, defaults and archive.",
    accounts: "Provider accounts",
    proxies: "Proxies",
    connectedCount: "connected",
    inAppManaged: "Managed inside Coding Tools",
    addAccount: "Add account",
    addProxy: "Add proxy",
    edit: "Edit",
    connect: "Login / refresh",
    confirmConnected: "Confirm connected",
    setDefault: "Set default",
    default: "Default",
    enable: "Enable",
    disable: "Disable",
    archive: "Archive",
    archiveAccountConfirm: "Archive this account? The record will be preserved and can be migrated later.",
    archiveProxyConfirm: "Archive this proxy profile? The record is preserved; active routes will fall back safely.",
    accountCount: "accounts",
    noAccounts: "No accounts configured",
    addFirstAccount: "Add the first account",
    status: "Status",
    auth: "Authentication",
    models: "Models",
    route: "Proxy route",
    providerRoute: "Provider default route",
    inherit: "Inherit provider / global",
    inheritGlobal: "Use global routing",
    direct: "Direct connection",
    customProfile: "Saved proxy",
    accountLabel: "Account name",
    accountIdentity: "Email, account ID, or endpoint label",
    provider: "Provider",
    authentication: "Authentication method",
    apiKey: "API key / token",
    baseUrl: "Base URL or reverse-proxy endpoint",
    modelList: "Models (comma separated)",
    secretNotice: "Secrets are encrypted locally and never returned to the renderer after saving.",
    saveAccount: "Save account",
    updateAccount: "Update account",
    cancel: "Cancel",
    connected: "Connected",
    pending: "Pending login",
    expired: "Expired",
    error: "Error",
    disabled: "Disabled",
    globalRouting: "Global traffic routing",
    globalRoutingBody: "Route Electron browser sessions and inherited provider traffic through one saved proxy. Loopback control traffic remains direct.",
    globalEnabled: "Enable global routing",
    globalProxy: "Global proxy profile",
    noProxySelected: "Choose a proxy profile",
    proxyName: "Profile name",
    protocol: "Protocol",
    host: "Host",
    port: "Port",
    username: "Username (optional)",
    password: "Password (optional)",
    bypass: "Bypass hosts (comma separated)",
    traffic: "Traffic scopes",
    saveProxy: "Save proxy",
    updateProxy: "Update proxy",
    test: "Test",
    latency: "Latency",
    healthy: "Reachable",
    unreachable: "Unreachable",
    neverTested: "Not tested",
    archived: "Archived",
    close: "Close",
    loading: "Loading provider accounts…",
    retry: "Retry",
    loginOpened: "Login page opened. Complete login, then choose Confirm connected.",
    accountSaved: "Account saved.",
    proxySaved: "Proxy profile saved.",
    globalUpdated: "Global routing updated.",
    accountArchived: "Account archived without deleting its record.",
    proxyArchived: "Proxy profile archived without deleting its record.",
    proxyTestPassed: "Proxy connection succeeded.",
    proxyTestFailed: "Proxy connection failed.",
    oauth: "OAuth",
    api_key: "API key",
    browser_session: "Browser session",
    local_proxy: "Local / reverse proxy",
    all: "All traffic",
    browser: "Browser",
    providerTraffic: "Provider API",
    oauthTraffic: "OAuth login",
    subagent: "Codex subagents",
    paseo: "Paseo",
    anneal: "Anneal",
    mcp: "MCP",
    websocket: "WebSocket",
    http: "HTTP",
    update: "Updates",
    locale: "繁中",
  },
  "zh-TW": {
    navigationGroup: "連線管理",
    navigationLabel: "供應商",
    title: "供應商",
    subtitle: "在同一個主控台連接供應商帳戶、驗證每條連線並決定流量路由——無需另外啟動伺服器。",
    console: "連線",
    consoleBody: "每個供應商的帳戶、憑證與連線健康狀態。",
    routing: "路由",
    routingBody: "供應商及帳戶層級的代理路由、預設與封存。",
    accounts: "供應商帳戶",
    proxies: "代理",
    connectedCount: "已連線",
    inAppManaged: "由 Coding Tools 內部管理",
    addAccount: "新增帳戶",
    addProxy: "新增代理",
    edit: "編輯",
    connect: "登入／重新整理",
    confirmConnected: "確認已連線",
    setDefault: "設為預設",
    default: "預設",
    enable: "啟用",
    disable: "停用",
    archive: "封存",
    archiveAccountConfirm: "封存此帳戶？帳戶記錄會保留，之後仍可遷移或恢復。",
    archiveProxyConfirm: "封存此代理設定？記錄會保留，現有路由會安全回退。",
    accountCount: "個帳戶",
    noAccounts: "尚未設定帳戶",
    addFirstAccount: "新增第一個帳戶",
    status: "狀態",
    auth: "驗證方式",
    models: "模型",
    route: "代理路由",
    providerRoute: "供應商預設路由",
    inherit: "沿用供應商／全域設定",
    inheritGlobal: "使用全域路由",
    direct: "直接連線",
    customProfile: "已儲存代理",
    accountLabel: "帳戶名稱",
    accountIdentity: "電郵、帳戶 ID 或端點標籤",
    provider: "供應商",
    authentication: "驗證方式",
    apiKey: "API Key／Token",
    baseUrl: "Base URL 或反向代理端點",
    modelList: "模型（以逗號分隔）",
    secretNotice: "憑證只會在本機加密儲存；儲存後不會再傳回介面。",
    saveAccount: "儲存帳戶",
    updateAccount: "更新帳戶",
    cancel: "取消",
    connected: "已連線",
    pending: "等待登入",
    expired: "已過期",
    error: "錯誤",
    disabled: "已停用",
    globalRouting: "全域流量路由",
    globalRoutingBody: "使用一個已儲存代理路由 Electron 瀏覽器及沿用設定的供應商流量；本機 Loopback 控制流量永遠直接連線。",
    globalEnabled: "啟用全域路由",
    globalProxy: "全域代理設定",
    noProxySelected: "選擇代理設定",
    proxyName: "設定名稱",
    protocol: "協定",
    host: "主機",
    port: "連接埠",
    username: "使用者名稱（可選）",
    password: "密碼（可選）",
    bypass: "略過主機（以逗號分隔）",
    traffic: "流量範圍",
    saveProxy: "儲存代理",
    updateProxy: "更新代理",
    test: "測試",
    latency: "延遲",
    healthy: "可連線",
    unreachable: "無法連線",
    neverTested: "未測試",
    archived: "已封存",
    close: "關閉",
    loading: "正在載入供應商帳戶…",
    retry: "重試",
    loginOpened: "登入頁面已開啟。完成登入後，請選擇「確認已連線」。",
    accountSaved: "帳戶已儲存。",
    proxySaved: "代理設定已儲存。",
    globalUpdated: "全域路由已更新。",
    accountArchived: "帳戶已封存，記錄並未刪除。",
    proxyArchived: "代理設定已封存，記錄並未刪除。",
    proxyTestPassed: "代理連線測試成功。",
    proxyTestFailed: "代理連線測試失敗。",
    oauth: "OAuth",
    api_key: "API Key",
    browser_session: "瀏覽器工作階段",
    local_proxy: "本機／反向代理",
    all: "所有流量",
    browser: "瀏覽器",
    providerTraffic: "供應商 API",
    oauthTraffic: "OAuth 登入",
    subagent: "Codex 子代理",
    paseo: "Paseo",
    anneal: "Anneal",
    mcp: "MCP",
    websocket: "WebSocket",
    http: "HTTP",
    update: "更新",
    locale: "EN",
  },
} as const;

const TRAFFIC_SCOPES: ProxyScope[] = [
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
];

interface ProxyDraft {
  id?: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  bypass: string;
  scopes: ProxyScope[];
}

function defaultProxyDraft(): ProxyDraft {
  return {
    name: "",
    protocol: "http",
    host: "",
    port: "8080",
    username: "",
    password: "",
    bypass: "localhost, 127.0.0.1, ::1, *.localhost",
    scopes: ["all"],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function policyValue(
  policy: { inheritGlobal?: boolean; inheritProvider?: boolean; profileId?: string } | undefined,
  account = false,
): string {
  if (!policy) return "inherit";
  if (policy.profileId) return `profile:${policy.profileId}`;
  if (account && policy.inheritProvider === false && policy.inheritGlobal !== false) return "global";
  if (policy.inheritGlobal === false) return "direct";
  return "inherit";
}

function parsePolicy(value: string): { mode: ProxyPolicyMode; profileId?: string } {
  if (value.startsWith("profile:")) return { mode: "profile", profileId: value.slice(8) };
  if (value === "direct" || value === "global") return { mode: value };
  return { mode: "inherit" };
}

function statusTone(status: ProviderAccountRecord["status"]): string {
  if (status === "connected") return "is-success";
  if (status === "pending") return "is-warning";
  if (status === "disabled") return "is-muted";
  return "is-error";
}

export function ProviderHubIntegration({ children }: { children: ReactNode }) {
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  const [workspaceHost, setWorkspaceHost] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [accountCount, setAccountCount] = useState(0);
  const [connectedCount, setConnectedCount] = useState(0);
  const [locale, setLocale] = useState<ProviderLocale>("en");
  const copy = COPY[locale];

  const handleAccountCount = useCallback((total: number, connected: number) => {
    setAccountCount(total);
    setConnectedCount(connected);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api?.snapshot()
      .then((snapshot) => {
        if (!cancelled) setLocale(providerLocale(snapshot.state.language));
      })
      .catch(() => undefined);
    const unsubscribe = api?.onStateChanged((state) => {
      setLocale(providerLocale(state.language));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const resolveHosts = () => {
      setNavigationHost(document.querySelector<HTMLElement>(".sidebar-nav"));
      setWorkspaceHost(document.querySelector<HTMLElement>(".workspace"));
    };
    resolveHosts();
    const observer = new MutationObserver(resolveHosts);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!navigationHost) return;
    const closeForNativeNavigation = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest(".sidebar-item") : null;
      if (target && !target.closest(".provider-sidebar-group")) setOpen(false);
    };
    navigationHost.addEventListener("click", closeForNativeNavigation, true);
    return () => navigationHost.removeEventListener("click", closeForNativeNavigation, true);
  }, [navigationHost]);

  useEffect(() => {
    if (!open) return;
    void api?.setBrowserSurfaceActive(false).catch(() => undefined);
  }, [open]);

  const changeLocale = () => {
    const next: Language = locale === "en" ? "zh-TW" : "en";
    void api?.setLanguage(next)
      .then(() => setLocale(providerLocale(next)))
      .catch(() => undefined);
  };

  return (
    <>
      {children}
      {navigationHost ? createPortal(
        <section className="sidebar-group provider-sidebar-group">
          <h2>{copy.navigationGroup}</h2>
          <button
            aria-current={open ? "page" : undefined}
            className={`sidebar-item provider-sidebar-item${open ? " is-active" : ""}`}
            onClick={() => setOpen(true)}
            title={accountCount > 0 ? `${connectedCount}/${accountCount} ${copy.connectedCount}` : undefined}
            type="button"
          >
            <Icon name="providers" />
            <span>{copy.navigationLabel}</span>
            {accountCount > 0 ? (
              <i className="sidebar-item-badge">
                <i
                  aria-hidden="true"
                  className={`action-dot ${connectedCount > 0 ? "is-success" : "is-optional"}`}
                />
              </i>
            ) : null}
          </button>
        </section>,
        navigationHost,
      ) : null}
      {open && workspaceHost ? createPortal(
        <div className="provider-manager-overlay">
          <ProviderManagerSurface
            copy={copy}
            locale={locale}
            onAccountCount={handleAccountCount}
            onClose={() => setOpen(false)}
            onToggleLocale={changeLocale}
          />
        </div>,
        workspaceHost,
      ) : null}
    </>
  );
}

export function ProviderManagerSurface({
  copy,
  locale,
  onAccountCount,
  onClose,
  onToggleLocale,
}: {
  copy: typeof COPY[ProviderLocale];
  locale: ProviderLocale;
  onAccountCount: (count: number, connected: number) => void;
  onClose: () => void;
  onToggleLocale: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [view, setView] = useState<ManagerView>("console");
  const [proxyDraft, setProxyDraft] = useState<ProxyDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    if (!api) return;
    setError(null);
    try {
      setSnapshot(await api.providerSnapshot());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  useEffect(() => {
    void load();
    return api?.onProviderNetworkChanged(setSnapshot);
  }, []);

  const activeAccounts = useMemo(
    () => snapshot?.accounts.filter((account) => !account.archivedAt) ?? [],
    [snapshot],
  );
  const activeProfiles = useMemo(
    () => snapshot?.proxyProfiles.filter((profile) => !profile.archivedAt) ?? [],
    [snapshot],
  );

  const connectedAccounts = useMemo(
    () => activeAccounts.filter((account) => account.enabled && account.status === "connected").length,
    [activeAccounts],
  );

  useEffect(
    () => onAccountCount(activeAccounts.length, connectedAccounts),
    [activeAccounts.length, connectedAccounts, onAccountCount],
  );

  const run = async <T,>(key: string, task: () => Promise<T>, success?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await task();
      if (result && typeof result === "object" && "accounts" in result) {
        setSnapshot(result as unknown as ProviderNetworkSnapshot);
      }
      if (success) setNotice(success);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  // Account creation, credentials, login and connection tests live in the SaaS
  // console (ProviderCenterSurface). This surface only keeps the routing layer.
  const archiveAccount = (account: ProviderAccountRecord) => {
    if (!api || !window.confirm(copy.archiveAccountConfirm)) return;
    void run(
      `archive:${account.id}`,
      () => api.archiveProviderAccount(account.id),
      copy.accountArchived,
    );
  };

  const submitProxy = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !proxyDraft) return;
    const input: ProxyProfileInput = {
      id: proxyDraft.id,
      name: proxyDraft.name,
      endpoint: {
        protocol: proxyDraft.protocol,
        host: proxyDraft.host,
        port: Number(proxyDraft.port),
      },
      scopes: proxyDraft.scopes,
      bypass: proxyDraft.bypass.split(",").map((host) => host.trim()).filter(Boolean),
      username: proxyDraft.username,
      password: proxyDraft.password,
    };
    const result = await run("proxy-save", () => api.saveProxyProfile(input), copy.proxySaved);
    if (result) setProxyDraft(null);
  };

  const openProxyEdit = (profile: ProxyProfileRecord) => {
    setProxyDraft({
      id: profile.id,
      name: profile.name,
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: String(profile.endpoint.port),
      username: "",
      password: "",
      bypass: profile.bypass.join(", "),
      scopes: [...profile.scopes],
    });
  };

  const archiveProxy = (profile: ProxyProfileRecord) => {
    if (!api || !window.confirm(copy.archiveProxyConfirm)) return;
    void run(
      `proxy-archive:${profile.id}`,
      () => api.archiveProxyProfile(profile.id),
      copy.proxyArchived,
    );
  };

  const setGlobalRouting = (enabled: boolean, profileId?: string | null) => {
    if (!api) return;
    void run(
      "global-routing",
      () => api.setGlobalProxyRouting({
        enabled,
        profileId: profileId ?? snapshot?.routing.globalProfileId ?? null,
      }),
      copy.globalUpdated,
    );
  };

  const setProviderPolicy = (providerId: string, value: string) => {
    if (!api) return;
    const policy = parsePolicy(value);
    void run(
      `provider-route:${providerId}`,
      () => api.setProviderProxyPolicy({ providerId, ...policy }),
    );
  };

  const setAccountPolicy = (accountId: string, value: string) => {
    if (!api) return;
    const policy = parsePolicy(value);
    void run(
      `account-route:${accountId}`,
      () => api.setAccountProxyPolicy({ accountId, ...policy }),
    );
  };

  if (!snapshot) {
    return (
      <section className="provider-manager is-loading">
        <div className="provider-manager-message">
          <strong>{copy.loading}</strong>
          {error ? <p>{error}</p> : null}
          <button onClick={() => void load()} type="button">{copy.retry}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="provider-manager" data-locale={locale} data-view={view}>
      <header className="provider-manager-header is-compact">
        <div className="provider-manager-heading">
          <span className="provider-manager-kicker">{copy.navigationGroup.toUpperCase()}</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="provider-manager-summary" aria-live="polite">
          <span className={`provider-summary-pill${connectedAccounts > 0 ? " is-success" : ""}`}>
            <i aria-hidden="true" />
            {connectedAccounts}/{activeAccounts.length} {copy.connectedCount}
          </span>
          <span className="provider-summary-pill">{activeProfiles.length} {copy.proxies}</span>
          <span className="provider-summary-pill is-muted">{copy.inAppManaged}</span>
        </div>
        <div className="provider-manager-header-actions">
          <button className="provider-language-button" onClick={onToggleLocale} type="button">
            {copy.locale}
          </button>
          <button className="provider-close-button" onClick={onClose} type="button" aria-label={copy.close}>×</button>
        </div>
      </header>

      <div className="provider-manager-tabs" role="tablist">
        {([
          ["console", copy.console, copy.consoleBody, activeAccounts.length],
          ["routing", copy.routing, copy.routingBody, PROVIDER_CATALOG.length],
          ["proxies", copy.proxies, copy.globalRouting, activeProfiles.length],
        ] as Array<[ManagerView, string, string, number]>).map(([id, label, body, count]) => (
          <button
            aria-selected={view === id}
            className={view === id ? "is-active" : ""}
            key={id}
            onClick={() => setView(id)}
            role="tab"
            title={body}
            type="button"
          >
            {label}<em>{count}</em>
          </button>
        ))}
      </div>

      {error || notice ? (
        <div className={`provider-manager-banner${error ? " is-error" : " is-success"}`}>
          {error ?? notice}
        </div>
      ) : null}

      <div className={`provider-manager-body${view === "console" ? " is-console" : ""}`}>
        {view === "console" ? (
          <ProviderCenterSurface
            language={locale === "zh-TW" ? "zh-TW" : "en"}
            setError={setError}
          />
        ) : null}
        {view === "routing" ? (
          <div className="provider-grid">
            {PROVIDER_CATALOG.map((provider) => {
              const accounts = activeAccounts.filter((account) => account.providerId === provider.id);
              const providerPolicy = snapshot.routing.providers.find((item) => item.providerId === provider.id);
              const connected = accounts.filter((account) => account.enabled && account.status === "connected").length;
              return (
                <article className="provider-card" data-connected={connected > 0} key={provider.id}>
                  <header className="provider-card-header">
                    <div className="provider-brand-mark" aria-hidden="true">
                      {provider.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <h2>{provider.name}</h2>
                      <p>{provider.category.replaceAll("_", " ")} · {accounts.length} {copy.accountCount} · {connected} {copy.connectedCount}</p>
                    </div>
                    <button
                      className="provider-add-account"
                      onClick={() => setView("console")}
                      type="button"
                    >
                      {copy.console} →
                    </button>
                  </header>

                  <label className="provider-route-control">
                    <span>{copy.providerRoute}</span>
                    <select
                      disabled={busy === `provider-route:${provider.id}`}
                      onChange={(event) => setProviderPolicy(provider.id, event.target.value)}
                      value={policyValue(providerPolicy)}
                    >
                      <option value="inherit">{copy.inheritGlobal}</option>
                      <option value="direct">{copy.direct}</option>
                      {activeProfiles.map((profile) => (
                        <option key={profile.id} value={`profile:${profile.id}`}>
                          {copy.customProfile}: {profile.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="provider-account-list">
                    {accounts.length === 0 ? (
                      <button className="provider-empty-account" onClick={() => setView("console")} type="button">
                        <strong>{copy.noAccounts}</strong>
                        <span>+ {copy.addFirstAccount}</span>
                      </button>
                    ) : accounts.map((account) => {
                      const accountPolicy = snapshot.routing.accounts.find((item) => item.accountId === account.id);
                      return (
                        <div className={`provider-account-row${account.enabled ? "" : " is-disabled"}`} key={account.id}>
                          <div className="provider-account-summary">
                            <div>
                              <strong>{account.label}</strong>
                              {account.identity ? <span>{account.identity}</span> : null}
                            </div>
                            <div className="provider-account-badges">
                              {account.isDefault ? <em className="provider-default-badge">{copy.default}</em> : null}
                              <em className={`provider-status-badge ${statusTone(account.status)}`}>
                                {copy[account.status]}
                              </em>
                            </div>
                          </div>

                          <dl className="provider-account-metadata">
                            <div><dt>{copy.auth}</dt><dd>{copy[account.auth]}</dd></div>
                            <div><dt>{copy.models}</dt><dd>{account.models.join(", ") || "Auto"}</dd></div>
                          </dl>

                          <label className="provider-account-route">
                            <span>{copy.route}</span>
                            <select
                              disabled={busy === `account-route:${account.id}`}
                              onChange={(event) => setAccountPolicy(account.id, event.target.value)}
                              value={policyValue(accountPolicy, true)}
                            >
                              <option value="inherit">{copy.inherit}</option>
                              <option value="global">{copy.inheritGlobal}</option>
                              <option value="direct">{copy.direct}</option>
                              {activeProfiles.map((profile) => (
                                <option key={profile.id} value={`profile:${profile.id}`}>
                                  {copy.customProfile}: {profile.name}
                                </option>
                              ))}
                            </select>
                          </label>

                          <div className="provider-account-actions">
                            <button onClick={() => setView("console")} type="button">{copy.edit}</button>
                            {!account.isDefault && account.status === "connected" && account.enabled ? (
                              <button
                                disabled={busy === `default:${account.id}`}
                                onClick={() => api && void run(
                                  `default:${account.id}`,
                                  () => api.setDefaultProviderAccount(account.providerId, account.id),
                                )}
                                type="button"
                              >
                                {copy.setDefault}
                              </button>
                            ) : null}
                            <button
                              onClick={() => api && void run(
                                `enabled:${account.id}`,
                                () => api.setProviderAccountEnabled(account.id, !account.enabled),
                              )}
                              type="button"
                            >
                              {account.enabled ? copy.disable : copy.enable}
                            </button>
                            <button className="is-danger" onClick={() => archiveAccount(account)} type="button">
                              {copy.archive}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {view === "proxies" ? (
          <div className="proxy-manager-panel">
            <section className="global-proxy-card">
              <div>
                <span className="provider-manager-kicker">GLOBAL ROUTING</span>
                <h2>{copy.globalRouting}</h2>
                <p>{copy.globalRoutingBody}</p>
              </div>
              <label className="global-proxy-switch">
                <input
                  checked={snapshot.routing.globalEnabled}
                  disabled={activeProfiles.length === 0 || busy === "global-routing"}
                  onChange={(event) => setGlobalRouting(event.target.checked)}
                  type="checkbox"
                />
                <span>{copy.globalEnabled}</span>
              </label>
              <label>
                <span>{copy.globalProxy}</span>
                <select
                  disabled={busy === "global-routing"}
                  onChange={(event) => setGlobalRouting(
                    snapshot.routing.globalEnabled,
                    event.target.value || null,
                  )}
                  value={snapshot.routing.globalProfileId ?? ""}
                >
                  <option value="">{copy.noProxySelected}</option>
                  {activeProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                  ))}
                </select>
              </label>
            </section>

            <div className="proxy-manager-toolbar">
              <h2>{copy.proxies}</h2>
              <button onClick={() => setProxyDraft(defaultProxyDraft())} type="button">+ {copy.addProxy}</button>
            </div>

            <div className="proxy-profile-grid">
              {activeProfiles.map((profile) => (
                <article className="proxy-profile-card" key={profile.id}>
                  <header>
                    <div>
                      <h3>{profile.name}</h3>
                      <p>{profile.endpoint.protocol.toUpperCase()} · {profile.endpoint.host}:{profile.endpoint.port}</p>
                    </div>
                    <span className={`proxy-health-dot${profile.lastError ? " is-error" : profile.lastCheckedAt ? " is-success" : ""}`} />
                  </header>
                  <div className="proxy-profile-health">
                    <span>{profile.lastError ? copy.unreachable : profile.lastCheckedAt ? copy.healthy : copy.neverTested}</span>
                    {profile.latencyMs !== undefined ? <em>{copy.latency}: {profile.latencyMs} ms</em> : null}
                  </div>
                  <p className="proxy-profile-scopes">{profile.scopes.map((scope) => (
                    scope === "provider" ? copy.providerTraffic
                      : scope === "oauth" ? copy.oauthTraffic
                        : copy[scope]
                  )).join(" · ")}</p>
                  {profile.lastError ? <p className="proxy-profile-error">{profile.lastError}</p> : null}
                  <footer>
                    <button onClick={() => openProxyEdit(profile)} type="button">{copy.edit}</button>
                    <button
                      disabled={busy === `proxy-test:${profile.id}`}
                      onClick={() => api && void run(
                        `proxy-test:${profile.id}`,
                        async () => {
                          const result = await api.testProxyProfile(profile.id);
                          setSnapshot(result.snapshot);
                          setNotice(result.reachable ? copy.proxyTestPassed : copy.proxyTestFailed);
                          return result.snapshot;
                        },
                      )}
                      type="button"
                    >
                      {copy.test}
                    </button>
                    <button className="is-danger" onClick={() => archiveProxy(profile)} type="button">
                      {copy.archive}
                    </button>
                  </footer>
                </article>
              ))}
              <button className="proxy-profile-add" onClick={() => setProxyDraft(defaultProxyDraft())} type="button">
                <strong>+</strong><span>{copy.addProxy}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {proxyDraft ? (
        <div className="provider-dialog-backdrop" role="presentation">
          <form className="provider-dialog provider-proxy-dialog" onSubmit={(event) => void submitProxy(event)}>
            <header>
              <h2>{proxyDraft.id ? copy.updateProxy : copy.addProxy}</h2>
              <button onClick={() => setProxyDraft(null)} type="button">×</button>
            </header>
            <label>
              <span>{copy.proxyName}</span>
              <input
                maxLength={160}
                onChange={(event) => setProxyDraft({ ...proxyDraft, name: event.target.value })}
                required
                value={proxyDraft.name}
              />
            </label>
            <div className="provider-dialog-row">
              <label>
                <span>{copy.protocol}</span>
                <select
                  onChange={(event) => setProxyDraft({ ...proxyDraft, protocol: event.target.value as ProxyProtocol })}
                  value={proxyDraft.protocol}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks4">SOCKS4</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </label>
              <label>
                <span>{copy.port}</span>
                <input
                  max="65535"
                  min="1"
                  onChange={(event) => setProxyDraft({ ...proxyDraft, port: event.target.value })}
                  required
                  type="number"
                  value={proxyDraft.port}
                />
              </label>
            </div>
            <label>
              <span>{copy.host}</span>
              <input
                onChange={(event) => setProxyDraft({ ...proxyDraft, host: event.target.value })}
                required
                value={proxyDraft.host}
              />
            </label>
            <div className="provider-dialog-row">
              <label>
                <span>{copy.username}</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProxyDraft({ ...proxyDraft, username: event.target.value })}
                  value={proxyDraft.username}
                />
              </label>
              <label>
                <span>{copy.password}</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProxyDraft({ ...proxyDraft, password: event.target.value })}
                  type="password"
                  value={proxyDraft.password}
                />
              </label>
            </div>
            <label>
              <span>{copy.bypass}</span>
              <input
                onChange={(event) => setProxyDraft({ ...proxyDraft, bypass: event.target.value })}
                value={proxyDraft.bypass}
              />
            </label>
            <fieldset className="provider-scope-grid">
              <legend>{copy.traffic}</legend>
              {TRAFFIC_SCOPES.map((scope) => (
                <label key={scope}>
                  <input
                    checked={proxyDraft.scopes.includes(scope)}
                    onChange={(event) => {
                      const scopes = event.target.checked
                        ? [...new Set([...proxyDraft.scopes, scope])]
                        : proxyDraft.scopes.filter((item) => item !== scope);
                      setProxyDraft({ ...proxyDraft, scopes: scopes.length > 0 ? scopes : ["all"] });
                    }}
                    type="checkbox"
                  />
                  <span>{scope === "provider" ? copy.providerTraffic : scope === "oauth" ? copy.oauthTraffic : copy[scope]}</span>
                </label>
              ))}
            </fieldset>
            <p className="provider-secret-notice">{copy.secretNotice}</p>
            <footer>
              <button onClick={() => setProxyDraft(null)} type="button">{copy.cancel}</button>
              <button className="is-primary" disabled={busy === "proxy-save"} type="submit">
                {proxyDraft.id ? copy.updateProxy : copy.saveProxy}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
