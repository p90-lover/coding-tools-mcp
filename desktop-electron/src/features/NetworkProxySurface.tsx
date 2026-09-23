import { useEffect, useMemo, useState } from "react";
import type {
  ExternalServiceSnapshot,
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
import "./network-proxy.css";

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
const PROXY_PATH_PROVIDERS = new Set(["claude-oauth", "anthropic-api"]);

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
    protocol: "http",
    host: "127.0.0.1",
    port: "17891",
    scopes: ["all", "browser", "provider", "oauth", "subagent", "paseo", "anneal", "mcp", "websocket", "http", "update"],
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
  const [cpa, setCpa] = useState<ExternalServiceSnapshot | null>(null);
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
    void Promise.all([api.providerSnapshot(), api.externalServicesSnapshot()]).then(([next, services]) => {
      if (cancelled) return;
      setSnapshot(next);
      setCpa(services.services.find((service) => service.id === "cpa") ?? null);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onProviderNetworkChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const unsubscribeServices = api.onExternalServicesChanged((next) => {
      if (!cancelled) setCpa(next.services.find((service) => service.id === "cpa") ?? null);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeServices();
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
      const services = await window.codexWebLauncher?.externalServicesSnapshot().catch(() => null);
      if (services) setCpa(services.services.find((service) => service.id === "cpa") ?? null);
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

  const applyToCpa = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.restartExternalService("cpa");
      setCpa(next);
      if (next.status !== "ready" || next.outboundProxy?.configMatches !== true) {
        throw new Error(next.outboundProxy?.error || next.error || "CPA did not apply the selected proxy route");
      }
      setNotice(localText(language,
        "CPA restarted with the selected route. Test a model request to verify outbound traffic.",
        "CPA 已用所選路由重新啟動。請測試模型請求以驗證外連。",
        "CPA 已使用所选路由重启。请测试模型请求以验证外连。",
        "CPA を選択した経路で再起動しました。モデル要求で送信経路を確認してください。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const setProviderPolicy = async (providerId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const nextMode = mode === "direct" && PROXY_PATH_PROVIDERS.has(providerId) ? "inherit" : mode;
    if (nextMode !== mode) {
      setNotice(localText(
        language,
        "Claude and Anthropic traffic stays on the proxy/SOCKS path; Direct is not used.",
        "Claude 同 Anthropic 流量必須走代理／SOCKS，唔會改成 Direct。",
        "Claude 和 Anthropic 流量必须走代理／SOCKS，不会改为 Direct。",
        "Claude / Anthropic の通信はプロキシ/SOCKS 経路のままです。Direct にはしません。",
      ));
    }
    await run(
      () => api.setProviderProxyPolicy({ providerId, mode: nextMode, ...(profileId ? { profileId } : {}) }),
      `${providerId}: ${policyModeLabel(language, nextMode)}`,
    );
  };

  const setAccountPolicy = async (accountId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const account = snapshot?.accounts.find((candidate) => candidate.id === accountId);
    const nextMode = mode === "direct" && account && PROXY_PATH_PROVIDERS.has(account.providerId)
      ? "inherit"
      : mode;
    if (nextMode !== mode) {
      setNotice(localText(
        language,
        "Claude and Anthropic traffic stays on the proxy/SOCKS path; Direct is not used.",
        "Claude 同 Anthropic 流量必須走代理／SOCKS，唔會改成 Direct。",
        "Claude 和 Anthropic 流量必须走代理／SOCKS，不会改为 Direct。",
        "Claude / Anthropic の通信はプロキシ/SOCKS 経路のままです。Direct にはしません。",
      ));
    }
    await run(
      () => api.setAccountProxyPolicy({ accountId, mode: nextMode, ...(profileId ? { profileId } : {}) }),
      `${accountId}: ${policyModeLabel(language, nextMode)}`,
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
  const globalProfile = profiles.find((profile) => profile.id === globalProfileId);
  const globalEnabled = snapshot?.routing.globalEnabled === true;
  const cpaConfigured = cpa?.status === "ready" && cpa.outboundProxy?.configMatches === true;
  const customRuleCount = (snapshot?.routing.providers.filter((rule) => rule.profileId || rule.inheritGlobal === false).length ?? 0)
    + (snapshot?.routing.accounts.filter((rule) => rule.profileId || rule.inheritGlobal === false || rule.inheritProvider === false).length ?? 0);

  return (
    <section className="control-surface network-proxy-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">{localText(language, "NETWORK", "網路", "网络", "ネットワーク")}</span>
          <h1>{localText(language, "Network Proxy", "網路代理", "网络代理", "ネットワークプロキシ")}</h1>
          <p>{localText(
            language,
            "Manage the browser route and CPA outbound proxy from one place. Saved provider and account rules remain available below.",
            "喺同一頁管理瀏覽器同 CPA 嘅外連代理。供應商及帳戶規則喺下方。",
            "在同一页管理浏览器和 CPA 的出站代理。供应商和账户规则在下方。",
            "ブラウザーと CPA の送信プロキシをまとめて管理します。プロバイダーとアカウントの規則は下にあります。",
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
          <span>{localText(language, "Use the global proxy profile", "使用全域代理設定檔", "使用全局代理配置", "グローバルプロキシを使用")}</span>
        </label>
        <select
          aria-label={localText(language, "Global proxy profile", "全域代理設定檔", "全局代理配置", "グローバルプロキシ設定")}
          disabled={busy || profiles.length === 0}
          value={globalProfileId}
          onChange={(event) => void setGlobal(snapshot?.routing.globalEnabled === true, event.target.value)}
        >
          <option value="">—</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <small>{localText(
          language,
          "Browser routing updates immediately. Restart CPA below to apply its outbound route. Local control connections stay on loopback.",
          "瀏覽器路由即時更新。喺下方重新啟動 CPA 以套用外連路由。本機控制連線維持喺 loopback。",
          "浏览器路由立即更新。在下方重启 CPA 以应用出站路由。本地控制连接保持 loopback。",
          "ブラウザー経路はすぐに更新されます。CPA の送信経路は下で再起動して適用します。ローカル制御はループバックのままです。",
        )}</small>
      </section>

      <section className="proxy-route-overview" aria-labelledby="proxy-route-heading">
        <div className="proxy-route-header">
          <div>
            <span className="surface-kicker">{localText(language, "CURRENT ROUTE", "目前路由", "当前路由", "現在の経路")}</span>
            <h2 id="proxy-route-heading">{localText(language, "Where requests go", "請求去向", "请求去向", "要求の送信先")}</h2>
          </div>
          <span className={`proxy-route-badge${cpaConfigured ? " is-ready" : ""}`}>
            {!cpa
              ? localText(language, "Checking CPA", "檢查 CPA", "检查 CPA", "CPA を確認中")
              : cpaConfigured
                ? localText(language, "CPA configured", "CPA 已設定", "CPA 已配置", "CPA 設定済み")
                : localText(language, "CPA needs attention", "CPA 需要處理", "CPA 需要处理", "CPA の確認が必要")}
          </span>
        </div>
        <dl className="proxy-route-list">
          <div><dt>{localText(language, "Browser", "瀏覽器", "浏览器", "ブラウザー")}</dt><dd>{globalEnabled ? globalProfile?.name ?? "—" : policyModeLabel(language, "direct")}</dd></div>
          <div><dt>CPA</dt><dd>{cpa?.outboundProxy?.error
            || (cpa?.managedInstall.state !== "installed"
              ? localText(language, "Install CPA first", "請先安裝 CPA", "请先安装 CPA", "先に CPA をインストール")
              : cpaConfigured
                ? (globalEnabled ? globalProfile?.name ?? "—" : policyModeLabel(language, "direct"))
                : localText(language, "Restart to apply the saved route", "重新啟動以套用已儲存路由", "重启以应用已保存路由", "再起動して保存済みの経路を適用"))}</dd></div>
        </dl>
        <div className="proxy-route-actions">
          <button className="primary-button compact" disabled={busy || cpa?.managedInstall.state !== "installed"} onClick={() => void applyToCpa()} type="button">
            {localText(language, "Apply route to CPA", "套用路由至 CPA", "应用路由到 CPA", "CPA に経路を適用")}
          </button>
          <small>{localText(language,
            "This restarts CPA and interrupts active CPA model requests. A reachable proxy alone does not prove a model can answer.",
            "呢個動作會重新啟動 CPA，並中斷進行中嘅 CPA 模型請求。代理可連線唔代表模型一定會回應。",
            "此操作会重启 CPA，并中断正在进行的 CPA 模型请求。代理可连接不代表模型一定能回答。",
            "CPA を再起動し、進行中のモデル要求を中断します。プロキシへの接続だけではモデルの応答は確認できません。")}</small>
        </div>
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
          <p className="proxy-secret-help">{localText(language,
            "Leave username and password blank to keep saved credentials.",
            "使用者名稱同密碼留空會保留已儲存憑證。",
            "用户名和密码留空会保留已保存凭据。",
            "ユーザー名とパスワードを空欄にすると保存済みの認証情報を維持します。")}</p>
          <details className="proxy-detail-group">
            <summary>{localText(language, "Traffic categories for this profile", "此設定檔嘅流量類別", "此配置的流量类别", "このプロキシの通信区分")} <span>{draft.scopes.length}</span></summary>
            <p className="proxy-secret-help">{localText(language,
              "These categories limit planned provider work. The global browser and CPA route use the selected profile regardless of category.",
              "呢啲類別限制供應商任務路由。全域瀏覽器同 CPA 路由仍會使用所選設定檔。",
              "这些类别限制供应商任务路由。全局浏览器和 CPA 路由仍使用所选配置。",
              "この区分はプロバイダーの作業経路を制限します。ブラウザーと CPA のグローバル経路は選択した設定を使用します。")}</p>
            <div className="scope-grid">
              {SCOPES.map((scope) => <label className="check-row" key={scope}><input checked={draft.scopes.includes(scope)} onChange={() => toggleScope(scope)} type="checkbox" /><span>{scopeLabel(language, scope)}</span></label>)}
            </div>
          </details>
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

      <details className="proxy-detail-group proxy-advanced">
        <summary>{localText(language, "Provider and account routing", "供應商同帳戶路由", "供应商和账户路由", "プロバイダーとアカウントの経路")}
          <span>{customRuleCount}</span>
        </summary>
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
      </details>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}
