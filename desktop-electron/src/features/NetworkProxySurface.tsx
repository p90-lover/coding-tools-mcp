import { useEffect, useMemo, useState } from "react";
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
import { localText, messageOf } from "./execution-surface-utils";
import "./orchestration-control.css";

const SCOPES: readonly ProxyScope[] = [
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
const MODES: readonly ProxyPolicyMode[] = ["inherit", "global", "direct", "profile"];
const LOOPBACK_BYPASS = "localhost,127.0.0.1,::1";

type ProxyStatus = "error" | "enabled" | "disabled";

interface ProfileDraft {
  id?: string;
  name: string;
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  scopes: ProxyScope[];
  bypass: string;
  username: string;
  password: string;
}

function scopeLabel(language: Language, scope: ProxyScope): string {
  switch (scope) {
    case "all":
      return localText(language, "All application traffic", "所有應用程式流量", "所有应用程序流量", "すべてのアプリ通信");
    case "browser":
      return localText(language, "Browser", "瀏覽器", "浏览器", "ブラウザー");
    case "provider":
      return localText(language, "Provider", "供應商", "供应商", "プロバイダー");
    case "oauth":
      return "OAuth";
    case "subagent":
      return localText(language, "Subagents", "子代理", "子代理", "サブエージェント");
    case "paseo":
      return "Paseo";
    case "anneal":
      return "Anneal";
    case "mcp":
      return "MCP";
    case "websocket":
      return "WebSocket";
    case "http":
      return "HTTP";
    case "update":
      return localText(language, "Updates", "更新服務", "更新服务", "更新");
  }
}

function policyModeLabel(language: Language, mode: ProxyPolicyMode): string {
  switch (mode) {
    case "inherit":
      return localText(language, "Inherit", "繼承", "继承", "継承");
    case "global":
      return localText(language, "Global", "全域", "全局", "グローバル");
    case "direct":
      return localText(language, "Direct", "直接連線", "直接连接", "直接接続");
    case "profile":
      return localText(language, "Proxy profile", "指定設定檔", "指定配置", "プロキシ設定");
  }
}

function statusLabel(language: Language, status: ProxyStatus): string {
  switch (status) {
    case "error":
      return localText(language, "Error", "錯誤", "错误", "エラー");
    case "enabled":
      return localText(language, "Enabled", "已啟用", "已启用", "有効");
    case "disabled":
      return localText(language, "Disabled", "已停用", "已停用", "無効");
  }
}

function emptyDraft(language: Language): ProfileDraft {
  return {
    name: localText(language, "Global proxy", "全域代理", "全局代理", "グローバルプロキシ"),
    enabled: true,
    protocol: "socks5",
    host: "127.0.0.1",
    port: "7890",
    scopes: ["all", "browser", "provider", "oauth", "subagent", "paseo", "anneal", "websocket", "http", "update"],
    bypass: LOOPBACK_BYPASS,
    username: "",
    password: "",
  };
}

function fromProfile(profile: ProxyProfileRecord): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    protocol: profile.endpoint.protocol,
    host: profile.endpoint.host,
    port: String(profile.endpoint.port),
    scopes: [...profile.scopes],
    bypass: profile.bypass.join(","),
    username: "",
    password: "",
  };
}

function policyMode(profileId: string | undefined, inheritGlobal: boolean): ProxyPolicyMode {
  if (profileId) return "profile";
  return inheritGlobal ? "inherit" : "direct";
}

function accountPolicyMode(
  snapshot: ProviderNetworkSnapshot,
  account: ProviderAccountRecord,
): ProxyPolicyMode {
  const policy = snapshot.routing.accounts.find((candidate) => candidate.accountId === account.id);
  if (policy?.profileId) return "profile";
  if (policy && !policy.inheritProvider && policy.inheritGlobal) return "global";
  if (policy && !policy.inheritProvider && !policy.inheritGlobal) return "direct";
  return "inherit";
}

export function NetworkProxySurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(() => emptyDraft(language));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const profiles = snapshot?.proxyProfiles.filter((profile) => !profile.archivedAt) ?? [];
  const selected = profiles.find((profile) => profile.id === selectedId);
  const providers = useMemo(
    () => [...new Set((snapshot?.accounts ?? []).filter((account) => !account.archivedAt).map((account) => account.providerId))],
    [snapshot],
  );

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api) return;
    let cancelled = false;
    void api.providerSnapshot().then((next) => {
      if (!cancelled) setSnapshot(next);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onProviderNetworkChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError]);

  useEffect(() => {
    if (selected) setDraft(fromProfile(selected));
  }, [selected?.id, selected?.updatedAt]);

  const run = async (operation: () => Promise<ProviderNetworkSnapshot>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation());
      setNotice(success);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const port = Number(draft.port);
    if (!draft.name.trim() || !draft.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError(localText(
        language,
        "Enter a valid proxy name, host and port.",
        "請輸入有效嘅代理名稱、主機同連接埠。",
        "请输入有效的代理名称、主机和端口。",
        "有効なプロキシ名、ホスト、ポートを入力してください。",
      ));
      return;
    }
    const input: ProxyProfileInput = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      enabled: draft.enabled,
      endpoint: { protocol: draft.protocol, host: draft.host.trim(), port },
      scopes: draft.scopes,
      bypass: draft.bypass.split(",").map((item) => item.trim()).filter(Boolean),
      ...(draft.username ? { username: draft.username } : {}),
      ...(draft.password ? { password: draft.password } : {}),
    };
    await run(async () => {
      const next = await api.saveProxyProfile(input);
      const profile = next.proxyProfiles.find((candidate) => (
        candidate.id === draft.id || candidate.name === input.name
      ));
      if (profile) setSelectedId(profile.id);
      setDraft((current) => ({ ...current, username: "", password: "" }));
      return next;
    }, localText(language, "Proxy profile saved.", "代理設定檔已儲存。", "代理配置已保存。", "プロキシを保存しました。"));
  };

  const testProfile = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.testProxyProfile(selectedId);
      setSnapshot(result.snapshot);
      setNotice(result.reachable
        ? localText(
            language,
            `Proxy reachable in ${result.latencyMs ?? 0} ms.`,
            `代理可連線，延遲 ${result.latencyMs ?? 0} 毫秒。`,
            `代理可连接，延迟 ${result.latencyMs ?? 0} 毫秒。`,
            `プロキシに接続できました（${result.latencyMs ?? 0} ms）。`,
          )
        : localText(
            language,
            `Proxy test failed: ${result.error ?? "unknown"}`,
            `代理測試失敗：${result.error ?? "未知"}`,
            `代理测试失败：${result.error ?? "未知"}`,
            `プロキシテストに失敗しました：${result.error ?? "不明"}`,
          ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const setGlobal = async (enabled: boolean, profileId = snapshot?.routing.globalProfileId) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    await run(
      () => api.setGlobalProxyRouting({ enabled, profileId: enabled ? profileId ?? null : null }),
      localText(
        language,
        enabled ? "App-wide proxy enabled." : "App-wide proxy disabled.",
        enabled ? "已啟用全應用程式代理。" : "已停用全應用程式代理。",
        enabled ? "已启用全应用程序代理。" : "已停用全应用程序代理。",
        enabled ? "アプリ全体のプロキシを有効にしました。" : "アプリ全体のプロキシを無効にしました。",
      ),
    );
  };

  const setProviderPolicy = async (providerId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    await run(
      () => api.setProviderProxyPolicy({ providerId, mode, ...(profileId ? { profileId } : {}) }),
      `${providerId}: ${policyModeLabel(language, mode)}`,
    );
  };

  const setAccountPolicy = async (accountId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    await run(
      () => api.setAccountProxyPolicy({ accountId, mode, ...(profileId ? { profileId } : {}) }),
      `${accountId}: ${policyModeLabel(language, mode)}`,
    );
  };

  const toggleScope = (scope: ProxyScope) => {
    setDraft((current) => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter((candidate) => candidate !== scope)
        : [...current.scopes, scope],
    }));
  };

  const globalProfileId = snapshot?.routing.globalProfileId ?? "";

  return (
    <section className="control-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">{localText(language, "NETWORK", "網路", "网络", "ネットワーク")}</span>
          <h1>{localText(language, "Network Proxy", "網路代理", "网络代理", "ネットワークプロキシ")}</h1>
          <p>{localText(
            language,
            "Route all application traffic or selected provider, account, OAuth, WebSocket and HTTP traffic through saved HTTP, HTTPS or SOCKS proxies.",
            "將所有應用程式流量，或指定供應商、帳戶、OAuth、WebSocket 及 HTTP 流量，路由至已儲存 HTTP、HTTPS 或 SOCKS 代理。",
            "将所有应用程序流量，或指定供应商、账户、OAuth、WebSocket 及 HTTP 流量，路由至已保存 HTTP、HTTPS 或 SOCKS 代理。",
            "アプリ全体または個別通信を HTTP / HTTPS / SOCKS プロキシへルーティングします。",
          )}</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => setDraft(emptyDraft(language))} type="button">
          + {localText(language, "New profile", "新增設定檔", "新增配置", "新規プロファイル")}
        </button>
      </header>

      <section className="global-proxy-banner">
        <label className="check-row">
          <input
            checked={snapshot?.routing.globalEnabled === true}
            disabled={busy || profiles.length === 0}
            onChange={(event) => void setGlobal(event.target.checked)}
            type="checkbox"
          />
          <span>{localText(language, "Route all application traffic", "路由所有應用程式流量", "路由所有应用程序流量", "すべての通信をルーティング")}</span>
        </label>
        <select
          disabled={busy || profiles.length === 0}
          value={globalProfileId}
          onChange={(event) => void setGlobal(snapshot?.routing.globalEnabled === true, event.target.value)}
        >
          <option value="">—</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <small>{localText(
          language,
          "Loopback control traffic remains direct: localhost, 127.0.0.1 and ::1.",
          "Loopback 控制流量保持直接連線：localhost、127.0.0.1 及 ::1。",
          "Loopback 控制流量保持直接连接：localhost、127.0.0.1 和 ::1。",
          "ループバック制御通信は直接接続のままです：localhost、127.0.0.1、::1。",
        )}</small>
      </section>

      <div className="control-grid proxy-grid">
        <aside className="control-panel proxy-list">
          <h2>{localText(language, "Proxy profiles", "代理設定檔", "代理配置", "プロキシ設定")}</h2>
          {profiles.map((profile) => (
            <button className={`proxy-row${profile.id === selectedId ? " is-selected" : ""}`} key={profile.id} onClick={() => setSelectedId(profile.id)} type="button">
              <div><strong>{profile.name}</strong><small>{profile.endpoint.protocol}://{profile.endpoint.host}:{profile.endpoint.port}</small></div>
              <span>{statusLabel(language, profile.lastError ? "error" : profile.enabled ? "enabled" : "disabled")}</span>
            </button>
          ))}
          {!profiles.length ? (
            <p className="empty-copy">{localText(language, "No proxy profiles.", "未有代理設定檔。", "没有代理配置。", "プロキシ設定はありません。")}</p>
          ) : null}
        </aside>

        <section className="control-panel proxy-editor">
          <h2>{draft.id
            ? localText(language, "Edit proxy", "編輯代理", "编辑代理", "プロキシを編集")
            : localText(language, "New proxy", "新增代理", "新增代理", "新規プロキシ")}</h2>
          <div className="control-fields proxy-fields">
            <label><span>{localText(language, "Name", "名稱", "名称", "名前")}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span>{localText(language, "Protocol", "通訊協定", "协议", "プロトコル")}</span><select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProxyProtocol })}><option value="http">http</option><option value="https">https</option><option value="socks4">socks4</option><option value="socks5">socks5</option></select></label>
            <label><span>{localText(language, "Host", "主機", "主机", "ホスト")}</span><input value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></label>
            <label><span>{localText(language, "Port", "連接埠", "端口", "ポート")}</span><input inputMode="numeric" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} /></label>
            <label><span>{localText(language, "Username", "使用者名稱", "用户名", "ユーザー名")}</span><input autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
            <label><span>{localText(language, "Password", "密碼", "密码", "パスワード")}</span><input autoComplete="off" type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /></label>
            <label className="full-row"><span>{localText(language, "Bypass", "略過位址", "绕过地址", "除外アドレス")}</span><input value={draft.bypass} onChange={(event) => setDraft({ ...draft, bypass: event.target.value })} /></label>
            <label className="check-row"><input checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} type="checkbox" /><span>{localText(language, "Enabled", "已啟用", "已启用", "有効")}</span></label>
          </div>
          <div className="scope-grid">
            {SCOPES.map((scope) => <label className="check-row" key={scope}><input checked={draft.scopes.includes(scope)} onChange={() => toggleScope(scope)} type="checkbox" /><span>{scopeLabel(language, scope)}</span></label>)}
          </div>
          <div className="control-actions">
            <button className="secondary-button" disabled={busy || !selectedId} onClick={() => void testProfile()} type="button">
              {localText(language, "Test connection", "測試連線", "测试连接", "接続テスト")}
            </button>
            <button className="primary-button compact" disabled={busy} onClick={() => void save()} type="button">
              {localText(language, "Save proxy", "儲存代理", "保存代理", "プロキシを保存")}
            </button>
          </div>
        </section>
      </div>

      <div className="control-grid two-column policy-grid">
        <section className="control-panel">
          <h2>{localText(language, "Provider routing", "供應商路由", "供应商路由", "プロバイダールーティング")}</h2>
          {providers.map((providerId) => {
            const policy = snapshot?.routing.providers.find((candidate) => candidate.providerId === providerId);
            const mode = policyMode(policy?.profileId, policy?.inheritGlobal !== false);
            return <div className="policy-row" key={providerId}><strong>{providerId}</strong><select disabled={busy} value={mode} onChange={(event) => void setProviderPolicy(providerId, event.target.value as ProxyPolicyMode, policy?.profileId)}>{MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}</select><select disabled={busy || mode !== "profile"} value={policy?.profileId ?? ""} onChange={(event) => void setProviderPolicy(providerId, "profile", event.target.value)}><option value="">—</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div>;
          })}
        </section>
        <section className="control-panel">
          <h2>{localText(language, "Account routing", "帳戶路由", "账户路由", "アカウントルーティング")}</h2>
          {(snapshot?.accounts ?? []).filter((account) => !account.archivedAt).map((account) => {
            const mode = snapshot ? accountPolicyMode(snapshot, account) : "inherit";
            const policy = snapshot?.routing.accounts.find((candidate) => candidate.accountId === account.id);
            return <div className="policy-row" key={account.id}><strong>{account.label}<small>{account.providerId}</small></strong><select disabled={busy} value={mode} onChange={(event) => void setAccountPolicy(account.id, event.target.value as ProxyPolicyMode, policy?.profileId)}>{MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}</select><select disabled={busy || mode !== "profile"} value={policy?.profileId ?? account.proxyProfileId ?? ""} onChange={(event) => void setAccountPolicy(account.id, "profile", event.target.value)}><option value="">—</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div>;
          })}
        </section>
      </div>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}
