import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  PROVIDER_CATALOG,
  type ProviderDefinition,
} from "./providers/provider-types";
import type {
  Language,
  ProviderAccountRecord,
  ProviderNetworkSnapshot,
  ProxyProfileRecord,
  ProxyProtocol,
  ProxyScope,
} from "./types";
import "./ProviderManagerSurface.css";

type ProviderView = "accounts" | "proxies";
type RouteMode = "inherit" | "global" | "direct" | "profile";

interface AccountDraft {
  providerId: string;
  label: string;
  identity: string;
  secret: string;
  models: string;
  isDefault: boolean;
}

interface ProxyDraft {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  scopes: ProxyScope[];
  bypass: string;
}

const DEFAULT_SCOPES: ProxyScope[] = [
  "browser",
  "provider",
  "oauth",
  "websocket",
  "http",
  "mcp",
  "paseo",
  "anneal",
];

const COPY = {
  en: {
    title: "Provider Hub",
    subtitle: "Manage every provider account and route traffic through saved proxy profiles.",
    accounts: "Accounts",
    proxies: "Proxy routing",
    addAccount: "Add account",
    addProxy: "Add proxy",
    search: "Search providers or accounts",
    activeAccounts: "Active accounts",
    connectedAccounts: "Connected",
    savedProxies: "Saved proxies",
    providerRoute: "Provider route",
    accountRoute: "Account route",
    inherit: "Inherit",
    global: "Global proxy",
    direct: "Direct connection",
    default: "Default",
    makeDefault: "Make default",
    login: "Login",
    markReady: "Mark ready",
    enable: "Enable",
    disable: "Disable",
    archive: "Archive",
    noAccounts: "No account configured for this provider.",
    provider: "Provider",
    label: "Account label",
    identity: "Email / identity",
    credential: "API key / token (stored encrypted)",
    models: "Models (comma separated)",
    useDefault: "Use as default account",
    save: "Save",
    cancel: "Cancel",
    globalRouting: "Global routing",
    globalRoutingHint: "Applies to enabled browser, provider, OAuth, WebSocket, MCP, Paseo, and Anneal scopes.",
    globalEnabled: "Enable global routing",
    selectProxy: "Select proxy profile",
    profileName: "Profile name",
    protocol: "Protocol",
    host: "Host",
    port: "Port",
    username: "Username (optional)",
    password: "Password (optional)",
    scopes: "Traffic scopes",
    bypass: "Bypass hosts (comma separated)",
    test: "Test",
    reachable: "Reachable",
    latency: "Latency",
    neverTested: "Not tested",
    loading: "Loading provider network…",
    unavailable: "Provider IPC is unavailable.",
    archivedNotice: "Archive keeps the record and never deletes credentials or history automatically.",
    enabled: "Enabled",
    disabled: "Disabled",
    pending: "Pending",
    expired: "Expired",
    error: "Error",
    connected: "Connected",
    routeProfile: "Saved profile",
    allProviders: "All providers",
    proxyAuthentication: "Authentication",
    none: "None",
  },
  zh: {
    title: "供應商中心",
    subtitle: "集中管理所有供應商帳戶，並使用已儲存的代理設定檔路由流量。",
    accounts: "帳戶",
    proxies: "代理路由",
    addAccount: "新增帳戶",
    addProxy: "新增代理",
    search: "搜尋供應商或帳戶",
    activeAccounts: "啟用帳戶",
    connectedAccounts: "已連線",
    savedProxies: "已儲存代理",
    providerRoute: "供應商路由",
    accountRoute: "帳戶路由",
    inherit: "繼承設定",
    global: "全域代理",
    direct: "直接連線",
    default: "預設",
    makeDefault: "設為預設",
    login: "登入",
    markReady: "標記為可用",
    enable: "啟用",
    disable: "停用",
    archive: "封存",
    noAccounts: "此供應商尚未設定帳戶。",
    provider: "供應商",
    label: "帳戶名稱",
    identity: "電郵／識別名稱",
    credential: "API key／token（加密儲存）",
    models: "模型（以逗號分隔）",
    useDefault: "設為預設帳戶",
    save: "儲存",
    cancel: "取消",
    globalRouting: "全域路由",
    globalRoutingHint: "套用到已啟用的瀏覽器、供應商、OAuth、WebSocket、MCP、Paseo 與 Anneal 流量範圍。",
    globalEnabled: "啟用全域路由",
    selectProxy: "選擇代理設定檔",
    profileName: "設定檔名稱",
    protocol: "協定",
    host: "主機",
    port: "連接埠",
    username: "使用者名稱（選填）",
    password: "密碼（選填）",
    scopes: "流量範圍",
    bypass: "略過主機（以逗號分隔）",
    test: "測試",
    reachable: "可連線",
    latency: "延遲",
    neverTested: "尚未測試",
    loading: "正在載入供應商網路…",
    unavailable: "Provider IPC 無法使用。",
    archivedNotice: "封存只會停用並保留紀錄，不會自動刪除憑證或歷史。",
    enabled: "已啟用",
    disabled: "已停用",
    pending: "等待中",
    expired: "已過期",
    error: "錯誤",
    connected: "已連線",
    routeProfile: "已儲存設定檔",
    allProviders: "所有供應商",
    proxyAuthentication: "驗證",
    none: "無",
  },
} as const;

function copyFor(language: Language) {
  return language === "zh-CN" ? COPY.zh : COPY.en;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyAccountDraft(): AccountDraft {
  return {
    providerId: PROVIDER_CATALOG[0].id,
    label: "",
    identity: "",
    secret: "",
    models: "",
    isDefault: false,
  };
}

function emptyProxyDraft(): ProxyDraft {
  return {
    name: "",
    protocol: "http",
    host: "",
    port: "8080",
    username: "",
    password: "",
    scopes: [...DEFAULT_SCOPES],
    bypass: "localhost, 127.0.0.1, ::1, *.localhost",
  };
}

function providerFor(providerId: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId);
}

function statusTone(account: ProviderAccountRecord): string {
  if (!account.enabled || account.status === "disabled") return "is-disabled";
  if (account.status === "connected") return "is-connected";
  if (account.status === "error" || account.status === "expired") return "is-error";
  return "is-pending";
}

function splitList(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function providerPolicyValue(snapshot: ProviderNetworkSnapshot, providerId: string): string {
  const policy = snapshot.routing.providers.find((item) => item.providerId === providerId);
  if (!policy) return "inherit";
  if (policy.profileId) return `profile:${policy.profileId}`;
  return policy.inheritGlobal === false ? "direct" : "inherit";
}

function accountPolicyValue(snapshot: ProviderNetworkSnapshot, accountId: string): string {
  const policy = snapshot.routing.accounts.find((item) => item.accountId === accountId);
  if (!policy) return "inherit";
  if (policy.profileId) return `profile:${policy.profileId}`;
  if (policy.inheritProvider === false && policy.inheritGlobal === false) return "direct";
  if (policy.inheritProvider === false && policy.inheritGlobal !== false) return "global";
  return "inherit";
}

function parseRoute(value: string): { mode: RouteMode; profileId?: string } {
  if (value.startsWith("profile:")) {
    return { mode: "profile", profileId: value.slice("profile:".length) };
  }
  if (value === "global" || value === "direct") return { mode: value };
  return { mode: "inherit" };
}

export function ProviderManagerSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = copyFor(language);
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [view, setView] = useState<ProviderView>("accounts");
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccountDraft);
  const [proxyDraft, setProxyDraft] = useState<ProxyDraft>(emptyProxyDraft);

  useEffect(() => {
    const launcher = window.codexWebLauncher;
    if (!launcher) {
      setError(copy.unavailable);
      return;
    }
    let active = true;
    void launcher.providerSnapshot()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = launcher.onProviderNetworkChanged((next) => {
      if (active) setSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [copy.unavailable, setError]);

  const activeAccounts = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account.archivedAt),
    [snapshot],
  );
  const activeProxies = useMemo(
    () => (snapshot?.proxyProfiles ?? []).filter((profile) => !profile.archivedAt),
    [snapshot],
  );
  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return PROVIDER_CATALOG;
    return PROVIDER_CATALOG.filter((provider) => {
      if (`${provider.name} ${provider.id}`.toLowerCase().includes(query)) return true;
      return activeAccounts.some((account) => account.providerId === provider.id
        && `${account.label} ${account.identity ?? ""}`.toLowerCase().includes(query));
    });
  }, [activeAccounts, search]);

  async function applySnapshot(
    key: string,
    operation: () => Promise<ProviderNetworkSnapshot>,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await operation());
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    const launcher = window.codexWebLauncher;
    const provider = providerFor(accountDraft.providerId);
    if (!launcher || !provider) return;
    const secret = accountDraft.secret.trim();
    const saved = await applySnapshot("account-save", () => launcher.saveProviderAccount({
      providerId: provider.id,
      label: accountDraft.label,
      identity: accountDraft.identity || undefined,
      auth: provider.auth,
      enabled: true,
      isDefault: accountDraft.isDefault,
      models: splitList(accountDraft.models),
      ...(secret ? {
        secret: provider.auth === "api_key" ? { apiKey: secret } : { token: secret },
      } : {}),
    }));
    if (saved) {
      setAccountDraft(emptyAccountDraft());
      setShowAccountForm(false);
    }
  }

  async function submitProxy(event: FormEvent) {
    event.preventDefault();
    const launcher = window.codexWebLauncher;
    if (!launcher) return;
    const port = Number(proxyDraft.port);
    const saved = await applySnapshot("proxy-save", () => launcher.saveProxyProfile({
      name: proxyDraft.name,
      enabled: true,
      endpoint: {
        protocol: proxyDraft.protocol,
        host: proxyDraft.host,
        port,
      },
      scopes: proxyDraft.scopes.length > 0 ? proxyDraft.scopes : ["all"],
      bypass: splitList(proxyDraft.bypass),
      username: proxyDraft.username || undefined,
      password: proxyDraft.password || undefined,
    }));
    if (saved) {
      setProxyDraft(emptyProxyDraft());
      setShowProxyForm(false);
    }
  }

  async function markAccountReady(account: ProviderAccountRecord) {
    const launcher = window.codexWebLauncher;
    if (!launcher) return;
    await applySnapshot(`ready:${account.id}`, () => launcher.saveProviderAccount({
      id: account.id,
      providerId: account.providerId,
      label: account.label,
      identity: account.identity,
      auth: account.auth,
      status: "connected",
      enabled: true,
      isDefault: account.isDefault,
      models: account.models,
      proxyProfileId: account.proxyProfileId,
    }));
  }

  async function updateProviderRoute(providerId: string, value: string) {
    const launcher = window.codexWebLauncher;
    if (!launcher) return;
    const route = parseRoute(value);
    await applySnapshot(`provider-route:${providerId}`, () => launcher.setProviderProxyPolicy({
      providerId,
      mode: route.mode === "global" ? "inherit" : route.mode,
      profileId: route.profileId,
    }));
  }

  async function updateAccountRoute(accountId: string, value: string) {
    const launcher = window.codexWebLauncher;
    if (!launcher) return;
    const route = parseRoute(value);
    await applySnapshot(`account-route:${accountId}`, () => launcher.setAccountProxyPolicy({
      accountId,
      mode: route.mode,
      profileId: route.profileId,
    }));
  }

  async function toggleProxy(profile: ProxyProfileRecord) {
    const launcher = window.codexWebLauncher;
    if (!launcher) return;
    await applySnapshot(`proxy-toggle:${profile.id}`, () => launcher.saveProxyProfile({
      id: profile.id,
      name: profile.name,
      enabled: !profile.enabled,
      endpoint: profile.endpoint,
      scopes: profile.scopes,
      bypass: profile.bypass,
    }));
  }

  async function testProxy(profileId: string) {
    const launcher = window.codexWebLauncher;
    if (!launcher || busy) return;
    setBusy(`proxy-test:${profileId}`);
    setError(null);
    try {
      const result = await launcher.testProxyProfile(profileId);
      setSnapshot(result.snapshot);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!snapshot) {
    return <section className="provider-manager provider-manager--loading">{copy.loading}</section>;
  }

  const connectedCount = activeAccounts.filter((account) => account.status === "connected" && account.enabled).length;
  const currentGlobalProfile = snapshot.routing.globalProfileId ?? "";

  return (
    <section className="provider-manager">
      <header className="provider-manager__hero">
        <div>
          <span className="provider-manager__eyebrow">CPA-style control center</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <button
          className="provider-button provider-button--primary"
          onClick={() => view === "accounts" ? setShowAccountForm(true) : setShowProxyForm(true)}
          type="button"
        >
          {view === "accounts" ? copy.addAccount : copy.addProxy}
        </button>
      </header>

      <div className="provider-manager__stats">
        <div><strong>{activeAccounts.length}</strong><span>{copy.activeAccounts}</span></div>
        <div><strong>{connectedCount}</strong><span>{copy.connectedAccounts}</span></div>
        <div><strong>{activeProxies.length}</strong><span>{copy.savedProxies}</span></div>
      </div>

      <div className="provider-manager__tabs" role="tablist">
        <button
          aria-selected={view === "accounts"}
          className={view === "accounts" ? "is-active" : ""}
          onClick={() => setView("accounts")}
          role="tab"
          type="button"
        >
          {copy.accounts}
        </button>
        <button
          aria-selected={view === "proxies"}
          className={view === "proxies" ? "is-active" : ""}
          onClick={() => setView("proxies")}
          role="tab"
          type="button"
        >
          {copy.proxies}
        </button>
      </div>

      {view === "accounts" ? (
        <>
          <div className="provider-manager__toolbar">
            <input
              aria-label={copy.search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={copy.search}
              type="search"
              value={search}
            />
          </div>

          {showAccountForm ? (
            <form className="provider-editor" onSubmit={(event) => void submitAccount(event)}>
              <div className="provider-editor__heading">
                <div><h2>{copy.addAccount}</h2><p>{copy.archivedNotice}</p></div>
                <button className="provider-button" onClick={() => setShowAccountForm(false)} type="button">{copy.cancel}</button>
              </div>
              <div className="provider-editor__grid">
                <label>
                  <span>{copy.provider}</span>
                  <select
                    onChange={(event) => setAccountDraft((current) => ({ ...current, providerId: event.target.value }))}
                    value={accountDraft.providerId}
                  >
                    {PROVIDER_CATALOG.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </label>
                <label><span>{copy.label}</span><input required value={accountDraft.label} onChange={(event) => setAccountDraft((current) => ({ ...current, label: event.target.value }))} /></label>
                <label><span>{copy.identity}</span><input value={accountDraft.identity} onChange={(event) => setAccountDraft((current) => ({ ...current, identity: event.target.value }))} /></label>
                <label><span>{copy.credential}</span><input autoComplete="off" type="password" value={accountDraft.secret} onChange={(event) => setAccountDraft((current) => ({ ...current, secret: event.target.value }))} /></label>
                <label className="provider-editor__wide"><span>{copy.models}</span><input value={accountDraft.models} onChange={(event) => setAccountDraft((current) => ({ ...current, models: event.target.value }))} /></label>
                <label className="provider-check provider-editor__wide"><input checked={accountDraft.isDefault} onChange={(event) => setAccountDraft((current) => ({ ...current, isDefault: event.target.checked }))} type="checkbox" /><span>{copy.useDefault}</span></label>
              </div>
              <div className="provider-editor__actions"><button className="provider-button provider-button--primary" disabled={busy !== null} type="submit">{copy.save}</button></div>
            </form>
          ) : null}

          <div className="provider-grid">
            {visibleProviders.map((provider) => {
              const accounts = activeAccounts.filter((account) => account.providerId === provider.id);
              return (
                <article className="provider-card" key={provider.id}>
                  <header className="provider-card__header">
                    <div className="provider-card__identity">
                      <span>{provider.name.slice(0, 2).toUpperCase()}</span>
                      <div><h2>{provider.name}</h2><code>{provider.id}</code></div>
                    </div>
                    <select
                      aria-label={`${provider.name} ${copy.providerRoute}`}
                      disabled={busy !== null}
                      onChange={(event) => void updateProviderRoute(provider.id, event.target.value)}
                      value={providerPolicyValue(snapshot, provider.id)}
                    >
                      <option value="inherit">{copy.inherit}</option>
                      <option value="direct">{copy.direct}</option>
                      {activeProxies.filter((profile) => profile.enabled).map((profile) => (
                        <option key={profile.id} value={`profile:${profile.id}`}>{copy.routeProfile}: {profile.name}</option>
                      ))}
                    </select>
                  </header>

                  {accounts.length === 0 ? <p className="provider-card__empty">{copy.noAccounts}</p> : (
                    <div className="provider-account-list">
                      {accounts.map((account) => (
                        <div className="provider-account" key={account.id}>
                          <div className="provider-account__main">
                            <span className={`provider-status ${statusTone(account)}`}>{copy[account.status]}</span>
                            <div>
                              <strong>{account.label}</strong>
                              <small>{account.identity || account.auth.replace("_", " ")}</small>
                            </div>
                            {account.isDefault ? <em>{copy.default}</em> : null}
                          </div>
                          <div className="provider-account__route">
                            <span>{copy.accountRoute}</span>
                            <select
                              disabled={busy !== null}
                              onChange={(event) => void updateAccountRoute(account.id, event.target.value)}
                              value={accountPolicyValue(snapshot, account.id)}
                            >
                              <option value="inherit">{copy.inherit}</option>
                              <option value="global">{copy.global}</option>
                              <option value="direct">{copy.direct}</option>
                              {activeProxies.filter((profile) => profile.enabled).map((profile) => (
                                <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="provider-account__actions">
                            {account.status !== "connected" ? (
                              <>
                                <button className="provider-button" disabled={busy !== null} onClick={() => void window.codexWebLauncher?.beginProviderLogin(account.id).catch((cause) => setError(messageOf(cause)))} type="button">{copy.login}</button>
                                <button className="provider-button" disabled={busy !== null} onClick={() => void markAccountReady(account)} type="button">{copy.markReady}</button>
                              </>
                            ) : null}
                            {!account.isDefault && account.status === "connected" && account.enabled ? (
                              <button className="provider-button" disabled={busy !== null} onClick={() => void applySnapshot(`default:${account.id}`, () => window.codexWebLauncher!.setDefaultProviderAccount(account.providerId, account.id))} type="button">{copy.makeDefault}</button>
                            ) : null}
                            <button className="provider-button" disabled={busy !== null} onClick={() => void applySnapshot(`enabled:${account.id}`, () => window.codexWebLauncher!.setProviderAccountEnabled(account.id, !account.enabled))} type="button">{account.enabled ? copy.disable : copy.enable}</button>
                            <button className="provider-button provider-button--danger" disabled={busy !== null} onClick={() => void applySnapshot(`archive:${account.id}`, () => window.codexWebLauncher!.archiveProviderAccount(account.id))} type="button">{copy.archive}</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <section className="provider-global-route">
            <div>
              <h2>{copy.globalRouting}</h2>
              <p>{copy.globalRoutingHint}</p>
            </div>
            <label className="provider-check">
              <input
                checked={snapshot.routing.globalEnabled}
                disabled={busy !== null || activeProxies.filter((profile) => profile.enabled).length === 0}
                onChange={(event) => {
                  const profileId = currentGlobalProfile || activeProxies.find((profile) => profile.enabled)?.id || null;
                  void applySnapshot("global-toggle", () => window.codexWebLauncher!.setGlobalProxyRouting({ enabled: event.target.checked, profileId }));
                }}
                type="checkbox"
              />
              <span>{copy.globalEnabled}</span>
            </label>
            <select
              aria-label={copy.selectProxy}
              disabled={busy !== null}
              onChange={(event) => void applySnapshot("global-profile", () => window.codexWebLauncher!.setGlobalProxyRouting({ enabled: snapshot.routing.globalEnabled, profileId: event.target.value || null }))}
              value={currentGlobalProfile}
            >
              <option value="">{copy.selectProxy}</option>
              {activeProxies.filter((profile) => profile.enabled).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </section>

          {showProxyForm ? (
            <form className="provider-editor" onSubmit={(event) => void submitProxy(event)}>
              <div className="provider-editor__heading">
                <div><h2>{copy.addProxy}</h2><p>{copy.archivedNotice}</p></div>
                <button className="provider-button" onClick={() => setShowProxyForm(false)} type="button">{copy.cancel}</button>
              </div>
              <div className="provider-editor__grid">
                <label><span>{copy.profileName}</span><input required value={proxyDraft.name} onChange={(event) => setProxyDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                <label><span>{copy.protocol}</span><select value={proxyDraft.protocol} onChange={(event) => setProxyDraft((current) => ({ ...current, protocol: event.target.value as ProxyProtocol }))}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select></label>
                <label><span>{copy.host}</span><input required value={proxyDraft.host} onChange={(event) => setProxyDraft((current) => ({ ...current, host: event.target.value }))} /></label>
                <label><span>{copy.port}</span><input max="65535" min="1" required type="number" value={proxyDraft.port} onChange={(event) => setProxyDraft((current) => ({ ...current, port: event.target.value }))} /></label>
                <label><span>{copy.username}</span><input autoComplete="off" value={proxyDraft.username} onChange={(event) => setProxyDraft((current) => ({ ...current, username: event.target.value }))} /></label>
                <label><span>{copy.password}</span><input autoComplete="new-password" type="password" value={proxyDraft.password} onChange={(event) => setProxyDraft((current) => ({ ...current, password: event.target.value }))} /></label>
                <fieldset className="provider-editor__wide"><legend>{copy.scopes}</legend><div className="provider-scope-grid">{DEFAULT_SCOPES.map((scope) => <label className="provider-check" key={scope}><input checked={proxyDraft.scopes.includes(scope)} onChange={(event) => setProxyDraft((current) => ({ ...current, scopes: event.target.checked ? [...current.scopes, scope] : current.scopes.filter((item) => item !== scope) }))} type="checkbox" /><span>{scope}</span></label>)}</div></fieldset>
                <label className="provider-editor__wide"><span>{copy.bypass}</span><input value={proxyDraft.bypass} onChange={(event) => setProxyDraft((current) => ({ ...current, bypass: event.target.value }))} /></label>
              </div>
              <div className="provider-editor__actions"><button className="provider-button provider-button--primary" disabled={busy !== null} type="submit">{copy.save}</button></div>
            </form>
          ) : null}

          <div className="provider-proxy-list">
            {activeProxies.map((profile) => (
              <article className="provider-proxy-card" key={profile.id}>
                <div className="provider-proxy-card__main">
                  <div><h2>{profile.name}</h2><code>{profile.endpoint.protocol}://{profile.endpoint.host}:{profile.endpoint.port}</code></div>
                  <span className={`provider-status ${profile.enabled ? "is-connected" : "is-disabled"}`}>{profile.enabled ? copy.enabled : copy.disabled}</span>
                </div>
                <div className="provider-proxy-card__meta">
                  <span>{copy.scopes}: {profile.scopes.join(", ")}</span>
                  <span>{copy.proxyAuthentication}: {profile.hasAuthentication ? copy.enabled : copy.none}</span>
                  <span>{profile.lastCheckedAt ? profile.lastError ? profile.lastError : `${copy.reachable} · ${copy.latency} ${profile.latencyMs ?? 0} ms` : copy.neverTested}</span>
                </div>
                <div className="provider-account__actions">
                  <button className="provider-button" disabled={busy !== null || !profile.enabled} onClick={() => void testProxy(profile.id)} type="button">{copy.test}</button>
                  <button className="provider-button" disabled={busy !== null} onClick={() => void toggleProxy(profile)} type="button">{profile.enabled ? copy.disable : copy.enable}</button>
                  <button className="provider-button provider-button--danger" disabled={busy !== null} onClick={() => void applySnapshot(`proxy-archive:${profile.id}`, () => window.codexWebLauncher!.archiveProxyProfile(profile.id))} type="button">{copy.archive}</button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
