import { useEffect, useMemo, useState } from "react";
import type {
  Language,
  ProviderAccountInput,
  ProviderNetworkSnapshot,
  ProxyPolicyMode,
  ProxyProfileInput,
  ProxyProtocol,
} from "../types";
import { PROVIDER_CATALOG, type ProviderDefinition } from "./provider-types";
import "./provider-manager.css";

const api = window.codexWebLauncher;

type Panel = "accounts" | "routing";

interface ProviderManagerSurfaceProps {
  language: Language;
  setError: (message: string | null) => void;
}

interface AccountDraft {
  providerId: string;
  label: string;
  identity: string;
  secret: string;
  models: string;
}

interface ProxyDraft {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  bypass: string;
}

const DEFAULT_ACCOUNT_DRAFT: AccountDraft = {
  providerId: "codex-oauth",
  label: "",
  identity: "",
  secret: "",
  models: "",
};

const DEFAULT_PROXY_DRAFT: ProxyDraft = {
  name: "",
  protocol: "http",
  host: "127.0.0.1",
  port: "7890",
  username: "",
  password: "",
  bypass: "localhost, 127.0.0.1, ::1",
};

export function ProviderManagerSurface({ language, setError }: ProviderManagerSurfaceProps) {
  const traditionalChinese = String(language).toLowerCase() === "zh-tw";
  const text = traditionalChinese ? ZH_TW : EN;
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [panel, setPanel] = useState<Panel>("accounts");
  const [busy, setBusy] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(DEFAULT_ACCOUNT_DRAFT);
  const [proxyDraft, setProxyDraft] = useState<ProxyDraft>(DEFAULT_PROXY_DRAFT);
  const [selectedGlobalProfile, setSelectedGlobalProfile] = useState("");

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.providerSnapshot()
      .then((value) => {
        if (cancelled) return;
        setSnapshot(value);
        setSelectedGlobalProfile(value.routing.globalProfileId ?? "");
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onProviderNetworkChanged((value) => {
      if (cancelled) return;
      setSnapshot(value);
      setSelectedGlobalProfile(value.routing.globalProfileId ?? "");
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError]);

  const activeAccounts = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account.archivedAt),
    [snapshot],
  );
  const activeProfiles = useMemo(
    () => (snapshot?.proxyProfiles ?? []).filter((profile) => !profile.archivedAt),
    [snapshot],
  );
  const selectedProvider = providerById(accountDraft.providerId);

  const run = async (operation: () => Promise<ProviderNetworkSnapshot>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveAccount = async () => {
    const provider = providerById(accountDraft.providerId);
    if (!provider || !accountDraft.label.trim()) {
      setError(text.accountRequired);
      return;
    }
    const id = `${provider.id}-${safeId(accountDraft.label)}-${Date.now().toString(36)}`;
    const input: ProviderAccountInput = {
      id,
      providerId: provider.id,
      label: accountDraft.label.trim(),
      identity: accountDraft.identity.trim() || undefined,
      auth: provider.auth,
      status: provider.auth === "oauth" || provider.auth === "browser_session" ? "pending" : "connected",
      enabled: true,
      isDefault: !activeAccounts.some((account) => account.providerId === provider.id),
      models: csv(accountDraft.models),
      secret: accountDraft.secret.trim() ? { credential: accountDraft.secret.trim() } : undefined,
    };
    await run(async () => {
      const next = await api!.saveProviderAccount(input);
      if (provider.auth === "oauth" || provider.auth === "browser_session") {
        await api!.beginProviderLogin(id);
      }
      setAccountDraft((current) => ({ ...DEFAULT_ACCOUNT_DRAFT, providerId: current.providerId }));
      return next;
    });
  };

  const saveProxy = async () => {
    const port = Number(proxyDraft.port);
    if (!proxyDraft.name.trim() || !proxyDraft.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError(text.proxyRequired);
      return;
    }
    const input: ProxyProfileInput = {
      name: proxyDraft.name.trim(),
      enabled: true,
      endpoint: {
        protocol: proxyDraft.protocol,
        host: proxyDraft.host.trim(),
        port,
      },
      scopes: ["all", "browser", "provider", "oauth", "websocket", "mcp", "paseo", "anneal", "update"],
      bypass: csv(proxyDraft.bypass),
      username: proxyDraft.username.trim() || undefined,
      password: proxyDraft.password || undefined,
    };
    await run(async () => {
      const next = await api!.saveProxyProfile(input);
      setProxyDraft(DEFAULT_PROXY_DRAFT);
      return next;
    });
  };

  const setGlobalRouting = (enabled: boolean) => run(() => api!.setGlobalProxyRouting({
    enabled,
    profileId: enabled ? selectedGlobalProfile || snapshot?.routing.globalProfileId : null,
  }));

  if (!api) {
    return <ProviderNotice tone="error">{text.ipcUnavailable}</ProviderNotice>;
  }

  return (
    <section className="provider-manager">
      <header className="provider-manager__hero">
        <div>
          <span>{text.eyebrow}</span>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <div className="provider-manager__summary">
          <Metric label={text.providers} value={PROVIDER_CATALOG.length} />
          <Metric label={text.accounts} value={activeAccounts.length} />
          <Metric label={text.proxyProfiles} value={activeProfiles.length} />
        </div>
      </header>

      <div className="provider-manager__tabs" role="tablist" aria-label={text.title}>
        <button
          aria-selected={panel === "accounts"}
          className={panel === "accounts" ? "is-active" : ""}
          onClick={() => setPanel("accounts")}
          role="tab"
          type="button"
        >
          {text.accountsTab}
        </button>
        <button
          aria-selected={panel === "routing"}
          className={panel === "routing" ? "is-active" : ""}
          onClick={() => setPanel("routing")}
          role="tab"
          type="button"
        >
          {text.routingTab}
        </button>
      </div>

      {!snapshot ? <ProviderNotice tone="neutral">{text.loading}</ProviderNotice> : null}

      {snapshot && panel === "accounts" ? (
        <div className="provider-manager__layout">
          <section className="provider-manager__panel">
            <PanelHeading title={text.addAccount} body={text.addAccountBody} />
            <div className="provider-manager__form-grid">
              <Field label={text.provider}>
                <select
                  disabled={busy}
                  onChange={(event) => setAccountDraft((current) => ({
                    ...current,
                    providerId: event.target.value,
                    secret: "",
                    models: "",
                  }))}
                  value={accountDraft.providerId}
                >
                  {PROVIDER_CATALOG.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={text.accountName}>
                <input
                  disabled={busy}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, label: event.target.value }))}
                  placeholder={text.accountPlaceholder}
                  value={accountDraft.label}
                />
              </Field>
              <Field label={text.identity}>
                <input
                  disabled={busy}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, identity: event.target.value }))}
                  placeholder="name@example.com"
                  value={accountDraft.identity}
                />
              </Field>
              <Field label={selectedProvider?.auth === "api_key" ? text.apiKey : text.credential}>
                <input
                  autoComplete="off"
                  disabled={busy || selectedProvider?.auth === "oauth" || selectedProvider?.auth === "browser_session"}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, secret: event.target.value }))}
                  placeholder={selectedProvider?.auth === "oauth" || selectedProvider?.auth === "browser_session"
                    ? text.loginAfterSave
                    : "••••••••"}
                  type="password"
                  value={accountDraft.secret}
                />
              </Field>
              <Field label={text.models} wide>
                <input
                  disabled={busy}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, models: event.target.value }))}
                  placeholder="gpt-5.6, claude-sonnet, gemini-3"
                  value={accountDraft.models}
                />
              </Field>
            </div>
            <div className="provider-manager__form-footer">
              <ProviderBadges provider={selectedProvider} text={text} />
              <button className="provider-manager__primary" disabled={busy} onClick={() => void saveAccount()} type="button">
                {busy ? text.saving : text.saveAccount}
              </button>
            </div>
          </section>

          <section className="provider-manager__panel provider-manager__panel--list">
            <PanelHeading title={text.savedAccounts} body={text.savedAccountsBody} />
            {activeAccounts.length === 0 ? <ProviderNotice tone="neutral">{text.noAccounts}</ProviderNotice> : null}
            <div className="provider-manager__cards">
              {activeAccounts.map((account) => {
                const provider = providerById(account.providerId);
                const policy = snapshot.routing.accounts.find((item) => item.accountId === account.id);
                return (
                  <article className="provider-account-card" key={account.id}>
                    <header>
                      <div>
                        <span className={`provider-account-card__status is-${account.status}`} />
                        <div>
                          <strong>{account.label}</strong>
                          <small>{provider?.name ?? account.providerId}{account.identity ? ` · ${account.identity}` : ""}</small>
                        </div>
                      </div>
                      {account.isDefault ? <em>{text.default}</em> : null}
                    </header>
                    <div className="provider-account-card__meta">
                      <span>{account.auth.replaceAll("_", " ")}</span>
                      <span>{account.models.length ? account.models.join(", ") : text.dynamicModels}</span>
                    </div>
                    <label className="provider-account-card__route">
                      <span>{text.proxyRoute}</span>
                      <select
                        disabled={busy}
                        onChange={(event) => void run(() => api!.setAccountProxyPolicy({
                          accountId: account.id,
                          mode: event.target.value as ProxyPolicyMode,
                          profileId: event.target.value.startsWith("profile:")
                            ? event.target.value.slice("profile:".length)
                            : undefined,
                        }))}
                        value={accountPolicyValue(policy)}
                      >
                        <option value="inherit">{text.inheritProvider}</option>
                        <option value="global">{text.useGlobal}</option>
                        <option value="direct">{text.direct}</option>
                        {activeProfiles.map((profile) => (
                          <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>
                        ))}
                      </select>
                    </label>
                    <footer>
                      {!account.isDefault ? (
                        <button disabled={busy} onClick={() => void run(() => api!.setDefaultProviderAccount(account.providerId, account.id))} type="button">
                          {text.makeDefault}
                        </button>
                      ) : null}
                      {(account.auth === "oauth" || account.auth === "browser_session") ? (
                        <button disabled={busy} onClick={() => void api!.beginProviderLogin(account.id).catch((cause) => setError(messageOf(cause)))} type="button">
                          {text.login}
                        </button>
                      ) : null}
                      <button disabled={busy} onClick={() => void run(() => api!.setProviderAccountEnabled(account.id, !account.enabled))} type="button">
                        {account.enabled ? text.disable : text.enable}
                      </button>
                      <button className="is-danger" disabled={busy} onClick={() => void run(() => api!.archiveProviderAccount(account.id))} type="button">
                        {text.archive}
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {snapshot && panel === "routing" ? (
        <div className="provider-manager__layout">
          <section className="provider-manager__panel">
            <PanelHeading title={text.globalRouting} body={text.globalRoutingBody} />
            <div className="provider-manager__global-route">
              <label>
                <span>{text.globalProfile}</span>
                <select
                  disabled={busy || activeProfiles.length === 0}
                  onChange={(event) => setSelectedGlobalProfile(event.target.value)}
                  value={selectedGlobalProfile}
                >
                  <option value="">{text.selectProfile}</option>
                  {activeProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                  ))}
                </select>
              </label>
              <button
                aria-pressed={snapshot.routing.globalEnabled}
                className={`provider-manager__route-toggle${snapshot.routing.globalEnabled ? " is-on" : ""}`}
                disabled={busy || (!snapshot.routing.globalEnabled && !selectedGlobalProfile)}
                onClick={() => void setGlobalRouting(!snapshot.routing.globalEnabled)}
                type="button"
              >
                <span />
                {snapshot.routing.globalEnabled ? text.routeAllEnabled : text.routeAllDisabled}
              </button>
            </div>
            <ProviderNotice tone={snapshot.routing.globalEnabled ? "success" : "neutral"}>
              {snapshot.routing.globalEnabled ? text.globalActive : text.globalInactive}
            </ProviderNotice>
          </section>

          <section className="provider-manager__panel">
            <PanelHeading title={text.addProxy} body={text.addProxyBody} />
            <div className="provider-manager__form-grid">
              <Field label={text.profileName}>
                <input disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, name: event.target.value }))} value={proxyDraft.name} />
              </Field>
              <Field label={text.protocol}>
                <select disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, protocol: event.target.value as ProxyProtocol }))} value={proxyDraft.protocol}>
                  {(["http", "https", "socks4", "socks5"] as ProxyProtocol[]).map((protocol) => (
                    <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>
                  ))}
                </select>
              </Field>
              <Field label={text.host}>
                <input disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, host: event.target.value }))} value={proxyDraft.host} />
              </Field>
              <Field label={text.port}>
                <input disabled={busy} inputMode="numeric" onChange={(event) => setProxyDraft((current) => ({ ...current, port: event.target.value }))} value={proxyDraft.port} />
              </Field>
              <Field label={text.username}>
                <input autoComplete="off" disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, username: event.target.value }))} value={proxyDraft.username} />
              </Field>
              <Field label={text.password}>
                <input autoComplete="new-password" disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, password: event.target.value }))} type="password" value={proxyDraft.password} />
              </Field>
              <Field label={text.bypass} wide>
                <input disabled={busy} onChange={(event) => setProxyDraft((current) => ({ ...current, bypass: event.target.value }))} value={proxyDraft.bypass} />
              </Field>
            </div>
            <div className="provider-manager__form-footer provider-manager__form-footer--end">
              <button className="provider-manager__primary" disabled={busy} onClick={() => void saveProxy()} type="button">
                {busy ? text.saving : text.saveProxy}
              </button>
            </div>
          </section>

          <section className="provider-manager__panel provider-manager__panel--wide">
            <PanelHeading title={text.savedProfiles} body={text.savedProfilesBody} />
            {activeProfiles.length === 0 ? <ProviderNotice tone="neutral">{text.noProfiles}</ProviderNotice> : null}
            <div className="provider-manager__proxy-grid">
              {activeProfiles.map((profile) => (
                <article className="proxy-profile-card" key={profile.id}>
                  <header>
                    <div>
                      <strong>{profile.name}</strong>
                      <small>{profile.endpoint.protocol.toUpperCase()} · {profile.endpoint.host}:{profile.endpoint.port}</small>
                    </div>
                    <span className={profile.lastError ? "is-error" : profile.lastCheckedAt ? "is-ready" : ""}>
                      {profile.lastError ? text.failed : profile.latencyMs ? `${profile.latencyMs} ms` : text.untested}
                    </span>
                  </header>
                  <p>{text.scopes}: {profile.scopes.join(", ")}</p>
                  <p>{text.bypass}: {profile.bypass.join(", ") || text.none}</p>
                  <footer>
                    <button disabled={busy} onClick={() => void run(async () => (await api!.testProxyProfile(profile.id)).snapshot)} type="button">{text.test}</button>
                    <button disabled={busy} onClick={() => {
                      setSelectedGlobalProfile(profile.id);
                      void run(() => api!.setGlobalProxyRouting({ enabled: true, profileId: profile.id }));
                    }} type="button">{text.useGlobally}</button>
                    <button className="is-danger" disabled={busy} onClick={() => void run(() => api!.archiveProxyProfile(profile.id))} type="button">{text.archive}</button>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function PanelHeading({ body, title }: { body: string; title: string }) {
  return <header className="provider-manager__panel-heading"><h2>{title}</h2><p>{body}</p></header>;
}

function Field({ children, label, wide = false }: { children: React.ReactNode; label: string; wide?: boolean }) {
  return <label className={wide ? "is-wide" : ""}><span>{label}</span>{children}</label>;
}

function ProviderNotice({ children, tone }: { children: React.ReactNode; tone: "neutral" | "success" | "error" }) {
  return <div className={`provider-manager__notice is-${tone}`}>{children}</div>;
}

function ProviderBadges({ provider, text }: { provider: ProviderDefinition | undefined; text: typeof EN }) {
  if (!provider) return null;
  return (
    <div className="provider-manager__badges">
      <span>{provider.auth.replaceAll("_", " ")}</span>
      {provider.paseoEnabled ? <span>{text.paseoReady}</span> : null}
      {provider.annealEnabled ? <span>{text.annealReady}</span> : null}
    </div>
  );
}

function providerById(id: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === id);
}

function accountPolicyValue(policy: ProviderNetworkSnapshot["routing"]["accounts"][number] | undefined): string {
  if (!policy) return "inherit";
  if (policy.profileId) return `profile:${policy.profileId}`;
  if (!policy.inheritProvider && !policy.inheritGlobal) return "direct";
  if (!policy.inheritProvider && policy.inheritGlobal) return "global";
  return "inherit";
}

function csv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const EN = {
  eyebrow: "Provider infrastructure",
  title: "Provider Hub",
  subtitle: "Manage multiple accounts, model access, failover, and app-wide network routing from one place.",
  providers: "Providers",
  accounts: "Accounts",
  proxyProfiles: "Proxy profiles",
  accountsTab: "Accounts & providers",
  routingTab: "Network & global proxy",
  loading: "Loading provider state…",
  addAccount: "Add provider account",
  addAccountBody: "OAuth, API-key, browser-session, and reverse-proxy accounts can coexist under one provider.",
  provider: "Provider",
  accountName: "Account name",
  accountPlaceholder: "Main, Backup, Work…",
  identity: "Identity (optional)",
  apiKey: "API key",
  credential: "Credential",
  loginAfterSave: "Login opens after save",
  models: "Models (comma-separated, optional)",
  saving: "Saving…",
  saveAccount: "Save account",
  accountRequired: "Choose a provider and enter an account name.",
  savedAccounts: "Saved accounts",
  savedAccountsBody: "Choose a default, keep fallbacks enabled, or archive an account without deleting its audit history.",
  noAccounts: "No provider accounts have been added yet.",
  default: "Default",
  dynamicModels: "Dynamic model discovery",
  proxyRoute: "Proxy route",
  inheritProvider: "Inherit provider policy",
  useGlobal: "Use global proxy",
  direct: "Direct connection",
  makeDefault: "Make default",
  login: "Login / reconnect",
  disable: "Disable",
  enable: "Enable",
  archive: "Archive",
  globalRouting: "Route all application traffic",
  globalRoutingBody: "Applies to browser, providers, OAuth, HTTP, WebSocket, MCP, Paseo, Anneal, and updater traffic. Local loopback control stays direct.",
  globalProfile: "Global proxy profile",
  selectProfile: "Select a proxy profile",
  routeAllEnabled: "Global routing enabled",
  routeAllDisabled: "Enable global routing",
  globalActive: "All eligible application traffic inherits the selected global proxy unless a provider or account override is set.",
  globalInactive: "Global routing is off. Provider and account-specific routes still apply.",
  addProxy: "Add proxy profile",
  addProxyBody: "Store reusable HTTP, HTTPS, SOCKS4, or SOCKS5 endpoints. Credentials are kept in encrypted storage.",
  profileName: "Profile name",
  protocol: "Protocol",
  host: "Host",
  port: "Port",
  username: "Username (optional)",
  password: "Password (optional)",
  bypass: "Bypass list",
  saveProxy: "Save proxy profile",
  proxyRequired: "Enter a profile name, valid host, and port between 1 and 65535.",
  savedProfiles: "Saved proxy profiles",
  savedProfilesBody: "Test connectivity, promote a profile to the global route, or archive it non-destructively.",
  noProfiles: "No proxy profiles have been added yet.",
  failed: "Failed",
  untested: "Not tested",
  scopes: "Scopes",
  none: "None",
  test: "Test",
  useGlobally: "Use globally",
  paseoReady: "Paseo",
  annealReady: "Anneal",
  ipcUnavailable: "Provider IPC is unavailable in this build.",
} as const;

const ZH_TW: typeof EN = {
  eyebrow: "提供者基礎架構",
  title: "提供者中心",
  subtitle: "集中管理多個帳戶、模型權限、故障轉移與全應用程式網路路由。",
  providers: "提供者",
  accounts: "帳戶",
  proxyProfiles: "代理設定檔",
  accountsTab: "帳戶與提供者",
  routingTab: "網路與全域代理",
  loading: "正在載入提供者狀態…",
  addAccount: "新增提供者帳戶",
  addAccountBody: "OAuth、API 金鑰、瀏覽器工作階段與反向代理帳戶可同時存在於同一提供者下。",
  provider: "提供者",
  accountName: "帳戶名稱",
  accountPlaceholder: "主要、備用、工作…",
  identity: "身分（選填）",
  apiKey: "API 金鑰",
  credential: "認證資料",
  loginAfterSave: "儲存後開啟登入",
  models: "模型（以逗號分隔，選填）",
  saving: "正在儲存…",
  saveAccount: "儲存帳戶",
  accountRequired: "請選擇提供者並輸入帳戶名稱。",
  savedAccounts: "已儲存帳戶",
  savedAccountsBody: "可指定預設帳戶、保留備援帳戶，或封存帳戶而不刪除稽核記錄。",
  noAccounts: "尚未新增提供者帳戶。",
  default: "預設",
  dynamicModels: "動態模型探索",
  proxyRoute: "代理路由",
  inheritProvider: "繼承提供者原則",
  useGlobal: "使用全域代理",
  direct: "直接連線",
  makeDefault: "設為預設",
  login: "登入／重新連線",
  disable: "停用",
  enable: "啟用",
  archive: "封存",
  globalRouting: "路由所有應用程式流量",
  globalRoutingBody: "套用至瀏覽器、提供者、OAuth、HTTP、WebSocket、MCP、Paseo、Anneal 與更新流量；本機 loopback 控制維持直接連線。",
  globalProfile: "全域代理設定檔",
  selectProfile: "選擇代理設定檔",
  routeAllEnabled: "已啟用全域路由",
  routeAllDisabled: "啟用全域路由",
  globalActive: "所有符合資格的應用程式流量會繼承所選全域代理；提供者或帳戶覆寫則優先。",
  globalInactive: "全域路由已關閉；提供者與帳戶專用路由仍會生效。",
  addProxy: "新增代理設定檔",
  addProxyBody: "儲存可重用的 HTTP、HTTPS、SOCKS4 或 SOCKS5 端點；認證資料保存在加密儲存空間。",
  profileName: "設定檔名稱",
  protocol: "協定",
  host: "主機",
  port: "連接埠",
  username: "使用者名稱（選填）",
  password: "密碼（選填）",
  bypass: "略過清單",
  saveProxy: "儲存代理設定檔",
  proxyRequired: "請輸入設定檔名稱、有效主機及 1 至 65535 的連接埠。",
  savedProfiles: "已儲存代理設定檔",
  savedProfilesBody: "可測試連線、提升為全域路由，或以非破壞方式封存。",
  noProfiles: "尚未新增代理設定檔。",
  failed: "失敗",
  untested: "尚未測試",
  scopes: "範圍",
  none: "無",
  test: "測試",
  useGlobally: "設為全域",
  paseoReady: "Paseo",
  annealReady: "Anneal",
  ipcUnavailable: "此版本無法使用提供者 IPC。",
};
