import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  ExternalServiceSnapshot,
  Language,
  ProviderAccountRecord,
  ProviderNetworkSnapshot,
  ProxyPolicyMode,
  ProxyProfileInput,
  ProxyProfileRecord,
  ProxyProtocol,
} from "../types";
import { localText, messageOf } from "./execution-surface-utils";
import "./network-proxy.css";

// The Proxy page: the app's own proxies, applied inside the app (the browser, CPA, providers and
// accounts). No other program is needed. One switch routes the app, a card picks the proxy.

const MODES: readonly ProxyPolicyMode[] = ["inherit", "global", "direct", "profile"];
const PROXY_PATH_PROVIDERS = new Set(["claude-oauth", "anthropic-api"]);
const PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5", "socks4"];
const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1", "*.localhost"];

interface Draft {
  id?: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  hasAuthentication: boolean;
}

const emptyDraft = (): Draft => ({ protocol: "http", host: "", port: "", username: "", password: "", hasAuthentication: false });
const draftOf = (profile: ProxyProfileRecord): Draft => ({
  id: profile.id, protocol: profile.endpoint.protocol, host: profile.endpoint.host, port: String(profile.endpoint.port),
  username: "", password: "", hasAuthentication: profile.hasAuthentication,
});

/** "http://user:pass@host:port", "host:port:user:pass" or "host:port" pasted into Host fills the form. */
function pastedProxy(text: string, draft: Draft): Draft | null {
  const value = text.trim();
  const url = /^(https?|socks[45]h?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/\s]+):(\d{1,5})\/?$/i.exec(value);
  if (url) {
    const protocol = url[1].toLowerCase().replace(/h$/, "") as ProxyProtocol;
    return { ...draft, protocol, host: url[4], port: url[5],
      username: decodeURIComponent(url[2] ?? ""), password: decodeURIComponent(url[3] ?? "") };
  }
  const parts = /^([^:\s]+):(\d{1,5})(?::([^:\s]+):(\S+))?$/.exec(value);
  if (parts) return { ...draft, host: parts[1], port: parts[2], username: parts[3] ?? draft.username, password: parts[4] ?? draft.password };
  return null;
}

function policyModeLabel(language: Language, mode: ProxyPolicyMode): string {
  switch (mode) {
    case "inherit": return localText(language, "Inherit", "繼承", "继承", "継承");
    case "global": return localText(language, "App proxy", "全域", "全局", "グローバル");
    case "direct": return localText(language, "Direct", "直接連線", "直接连接", "直接接続");
    case "profile": return localText(language, "Proxy", "指定代理", "指定代理", "プロキシ");
  }
}

function policyMode(profileId: string | undefined, inheritGlobal: boolean): ProxyPolicyMode {
  if (profileId) return "profile";
  return inheritGlobal ? "inherit" : "direct";
}

function accountPolicyMode(snapshot: ProviderNetworkSnapshot, account: ProviderAccountRecord): ProxyPolicyMode {
  const policy = snapshot.routing.accounts.find((candidate) => candidate.accountId === account.id);
  if (policy?.profileId) return "profile";
  if (policy && !policy.inheritProvider && policy.inheritGlobal) return "global";
  if (policy && !policy.inheritProvider && !policy.inheritGlobal) return "direct";
  return "inherit";
}

const Glyph = ({ d }: { d: string }) => (
  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15"><path d={d} /></svg>
);
const PULSE = "M3 12h4l3-8 4 16 3-8h4";
const PEN = "M4 20h4L19 9l-4-4L4 16v4z";
const BIN = "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13";
const PLUS = "M12 5v14M5 12h14";

export function NetworkProxySurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const t = (en: string, hk: string, cn: string, ja: string) => localText(language, en, hk, cn, ja);
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [cpa, setCpa] = useState<ExternalServiceSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState("");
  const [busy, setBusy] = useState(false);
  const deleteTimer = useRef<number | null>(null);

  const profiles = snapshot?.proxyProfiles.filter((profile) => !profile.archivedAt) ?? [];
  const globalOn = snapshot?.routing.globalEnabled === true;
  const activeId = snapshot?.routing.globalProfileId ?? "";
  const providers = useMemo(
    () => [...new Set(["cpa", ...(snapshot?.accounts ?? []).filter((account) => !account.archivedAt).map((account) => account.providerId)])],
    [snapshot],
  );
  const accounts = (snapshot?.accounts ?? []).filter((account) => !account.archivedAt);
  const customRoutes = (snapshot?.routing.providers.filter((rule) => rule.profileId || rule.inheritGlobal === false).length ?? 0)
    + (snapshot?.routing.accounts.filter((rule) => rule.profileId || rule.inheritGlobal === false || rule.inheritProvider === false).length ?? 0);
  const cpaInstalled = cpa?.managedInstall.state === "installed";
  const cpaOnRoute = cpa?.status === "ready" && cpa.outboundProxy?.configMatches === true;

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.providerSnapshot(), api.externalServicesSnapshot()]).then(([next, services]) => {
      if (cancelled) return;
      setSnapshot(next);
      setCpa(services.services.find((service) => service.id === "cpa") ?? null);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onProviderNetworkChanged((next) => { if (!cancelled) setSnapshot(next); });
    const unsubscribeServices = api.onExternalServicesChanged((next) => {
      if (!cancelled) setCpa(next.services.find((service) => service.id === "cpa") ?? null);
    });
    return () => { cancelled = true; unsubscribe(); unsubscribeServices(); };
  }, [setError]);

  useEffect(() => () => { if (deleteTimer.current) window.clearTimeout(deleteTimer.current); }, []);

  const run = async (operation: () => Promise<ProviderNetworkSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation());
      const services = await window.codexWebLauncher?.externalServicesSnapshot().catch(() => null);
      if (services) setCpa(services.services.find((service) => service.id === "cpa") ?? null);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async (profileId: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setTesting((current) => new Set(current).add(profileId));
    try {
      setSnapshot((await api.testProxyProfile(profileId)).snapshot);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setTesting((current) => { const next = new Set(current); next.delete(profileId); return next; });
    }
  };

  const route = (enabled: boolean, profileId: string | null) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    void run(() => api.setGlobalProxyRouting({ enabled, profileId }));
  };

  const save = async () => {
    const api = window.codexWebLauncher;
    if (!api || !draft) return;
    const port = Number(draft.port);
    if (!draft.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t("Enter a host and a port.", "請輸入主機同連接埠。", "请输入主机和端口。", "ホストとポートを入力してください。"));
      return;
    }
    const existing = profiles.find((profile) => profile.id === draft.id);
    const input: ProxyProfileInput = {
      ...(draft.id ? { id: draft.id } : {}),
      name: `${draft.protocol.toUpperCase()} ${draft.host.trim()}:${port}`,
      enabled: true,
      endpoint: { protocol: draft.protocol, host: draft.host.trim(), port },
      scopes: existing?.scopes ?? ["all"],
      bypass: existing?.bypass ?? LOOPBACK_BYPASS,
      ...(draft.username ? { username: draft.username } : {}),
      ...(draft.password ? { password: draft.password } : {}),
    };
    const firstProxy = profiles.length === 0;
    const saved = await run(async () => {
      let next = await api.saveProxyProfile(input);
      const profile = next.proxyProfiles.find((candidate) => !candidate.archivedAt && (draft.id
        ? candidate.id === draft.id : candidate.name === input.name));
      // The first proxy is the one the app uses; the switch turns it on.
      if (firstProxy && profile) next = await api.setGlobalProxyRouting({ enabled: true, profileId: profile.id });
      if (profile) void test(profile.id);
      return next;
    });
    if (saved) setDraft(null);
  };

  const remove = (profileId: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    if (confirmDelete !== profileId) {
      setConfirmDelete(profileId);
      if (deleteTimer.current) window.clearTimeout(deleteTimer.current);
      deleteTimer.current = window.setTimeout(() => setConfirmDelete(""), 3000);
      return;
    }
    setConfirmDelete("");
    if (draft?.id === profileId) setDraft(null);
    void run(() => api.archiveProxyProfile(profileId));
  };

  const applyToCpa = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.restartExternalService("cpa");
      setCpa(next);
      if (next.status !== "ready" || next.outboundProxy?.configMatches !== true) {
        throw new Error(next.outboundProxy?.error || next.error || "CPA didn't apply the proxy route. Try again.");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const setProviderPolicy = (providerId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    // Claude and Anthropic traffic always goes through a proxy, never Direct.
    const next = mode === "direct" && PROXY_PATH_PROVIDERS.has(providerId) ? "inherit" : mode;
    void run(() => api.setProviderProxyPolicy({ providerId, mode: next, ...(profileId ? { profileId } : {}) }));
  };

  const setAccountPolicy = (accountId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const account = accounts.find((candidate) => candidate.id === accountId);
    const next = mode === "direct" && account && PROXY_PATH_PROVIDERS.has(account.providerId) ? "inherit" : mode;
    void run(() => api.setAccountProxyPolicy({ accountId, mode: next, ...(profileId ? { profileId } : {}) }));
  };

  const health = (profile: ProxyProfileRecord) => {
    if (testing.has(profile.id)) return { tone: "is-testing", text: "" };
    if (profile.lastError) return { tone: "is-down", text: t("Unreachable", "連唔到", "无法连接", "接続不可") };
    if (profile.latencyMs !== undefined) return { tone: profile.latencyMs > 800 ? "is-slow" : "is-up", text: `${profile.latencyMs} ms` };
    return { tone: "", text: "" };
  };

  const editor = (key: string) => draft ? (
    <form className="px-editor" key={key} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="px-protocols" role="radiogroup" aria-label={t("Protocol", "通訊協定", "协议", "プロトコル")}>
        {PROTOCOLS.map((protocol) => (
          <button aria-checked={draft.protocol === protocol} className={draft.protocol === protocol ? "is-on" : ""} key={protocol}
            onClick={() => setDraft({ ...draft, protocol })} role="radio" type="button">{protocol.toUpperCase()}</button>
        ))}
      </div>
      <div className="px-fields">
        <input aria-label={t("Host", "主機", "主机", "ホスト")} autoFocus className="px-host" placeholder="host" value={draft.host}
          onChange={(event) => setDraft(pastedProxy(event.target.value, draft) ?? { ...draft, host: event.target.value })} />
        <input aria-label={t("Port", "連接埠", "端口", "ポート")} className="px-port" inputMode="numeric" placeholder="port" value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: event.target.value.replace(/\D/g, "").slice(0, 5) })} />
        <input aria-label={t("Username", "使用者名稱", "用户名", "ユーザー名")} autoComplete="off"
          placeholder={draft.hasAuthentication ? "••••••••" : t("username", "使用者名稱", "用户名", "ユーザー名")}
          value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
        <input aria-label={t("Password", "密碼", "密码", "パスワード")} autoComplete="off" type="password"
          placeholder={draft.hasAuthentication ? "••••••••" : t("password", "密碼", "密码", "パスワード")}
          value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
      </div>
      <div className="px-editor-actions">
        <button className="px-ghost" onClick={() => setDraft(null)} type="button">{t("Cancel", "取消", "取消", "キャンセル")}</button>
        <button className="px-primary" disabled={busy} type="submit">{t("Save", "儲存", "保存", "保存")}</button>
      </div>
    </form>
  ) : null;

  return (
    <section className={`px-page${globalOn ? " is-on" : ""}`}>
      <header className="px-head">
        <h1>{t("Proxy", "代理", "代理", "プロキシ")}</h1>
        <button aria-checked={globalOn} aria-label={t("Route the app through the proxy", "經代理連線", "经代理连接", "プロキシ経由で接続")}
          className={`switch${globalOn ? " is-on" : ""}`} disabled={busy || profiles.length === 0} role="switch" type="button"
          onClick={() => route(!globalOn, activeId || profiles[0]?.id || null)}><span /></button>
      </header>

      {!snapshot ? (
        <div className="px-list" aria-busy="true">{[0, 1].map((index) => <div className="px-card is-skeleton" key={index} />)}</div>
      ) : (
        <div className="px-list" role="radiogroup" aria-label={t("Proxies", "代理", "代理", "プロキシ")}>
          {profiles.map((profile, index) => {
            const active = profile.id === activeId;
            const state = health(profile);
            return (
              <div className="px-item" key={profile.id} style={{ "--i": index } as CSSProperties}>
                <div className={`px-card${active ? " is-active" : ""}`}>
                  <button aria-checked={active} className="px-pick" disabled={busy} role="radio" type="button"
                    onClick={() => route(globalOn, profile.id)}>
                    <span className="px-radio" />
                    <span className="px-proto">{profile.endpoint.protocol}</span>
                    <span className="px-addr">{profile.endpoint.host}<em>:{profile.endpoint.port}</em></span>
                    {profile.hasAuthentication ? <span className="px-lock" title={t("Signs in", "需要登入", "需要登录", "認証あり")}>●</span> : null}
                  </button>
                  <span className={`px-health ${state.tone}`} title={profile.lastError ?? undefined}><i />{state.text}</span>
                  <div className="px-tools">
                    <button aria-label={t("Test", "測試", "测试", "テスト")} disabled={testing.has(profile.id)} onClick={() => void test(profile.id)} type="button"><Glyph d={PULSE} /></button>
                    <button aria-label={t("Edit", "編輯", "编辑", "編集")} onClick={() => setDraft(draft?.id === profile.id ? null : draftOf(profile))} type="button"><Glyph d={PEN} /></button>
                    <button aria-label={t("Remove", "移除", "移除", "削除")} className={confirmDelete === profile.id ? "is-confirm" : ""} onClick={() => remove(profile.id)} type="button"><Glyph d={BIN} /></button>
                  </div>
                </div>
                <div className={`px-reveal${draft?.id === profile.id ? " is-open" : ""}`}><div>{draft?.id === profile.id ? editor(profile.id) : null}</div></div>
              </div>
            );
          })}
          <div className="px-item" style={{ "--i": profiles.length } as CSSProperties}>
            {draft && !draft.id ? null : (
              <button className="px-add" onClick={() => setDraft(emptyDraft())} type="button"><Glyph d={PLUS} />{t("Add proxy", "新增代理", "新增代理", "プロキシを追加")}</button>
            )}
            <div className={`px-reveal${draft && !draft.id ? " is-open" : ""}`}><div>{draft && !draft.id ? editor("new") : null}</div></div>
          </div>
        </div>
      )}

      {cpaInstalled ? (
        <div className="px-row">
          <span className={`px-dot${cpaOnRoute ? " is-up" : " is-slow"}`} />
          <span>CPA</span>
          {cpaOnRoute ? null : (
            <button className="px-ghost" disabled={busy} onClick={() => void applyToCpa()} type="button">{t("Apply", "套用", "应用", "適用")}</button>
          )}
        </div>
      ) : null}

      {snapshot && profiles.length ? (
        <details className="px-routes">
          <summary>{t("Routes", "路由", "路由", "経路")}{customRoutes ? <span>{customRoutes}</span> : null}</summary>
          <div className="px-route-list">
            {providers.map((providerId) => {
              const policy = snapshot.routing.providers.find((candidate) => candidate.providerId === providerId);
              const mode = policyMode(policy?.profileId, policy?.inheritGlobal !== false);
              return (
                <div className="px-route" key={providerId}>
                  <strong>{providerId}</strong>
                  <select disabled={busy} value={mode} onChange={(event) => setProviderPolicy(providerId, event.target.value as ProxyPolicyMode, policy?.profileId)}>
                    {MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}
                  </select>
                  {mode === "profile" ? (
                    <select disabled={busy} value={policy?.profileId ?? ""} onChange={(event) => setProviderPolicy(providerId, "profile", event.target.value)}>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.endpoint.host}:{profile.endpoint.port}</option>)}
                    </select>
                  ) : null}
                </div>
              );
            })}
            {accounts.map((account) => {
              const mode = accountPolicyMode(snapshot, account);
              const policy = snapshot.routing.accounts.find((candidate) => candidate.accountId === account.id);
              return (
                <div className="px-route" key={account.id}>
                  <strong>{account.label}<small>{account.providerId}</small></strong>
                  <select disabled={busy} value={mode} onChange={(event) => setAccountPolicy(account.id, event.target.value as ProxyPolicyMode, policy?.profileId)}>
                    {MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}
                  </select>
                  {mode === "profile" ? (
                    <select disabled={busy} value={policy?.profileId ?? account.proxyProfileId ?? ""} onChange={(event) => setAccountPolicy(account.id, "profile", event.target.value)}>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.endpoint.host}:{profile.endpoint.port}</option>)}
                    </select>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
}
