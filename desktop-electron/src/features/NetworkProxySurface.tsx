import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ExternalServiceSnapshot,
  Language,
  NovaApp,
  NovaConnection,
  NovaDecodo,
  NovaLogEntry,
  NovaProfile,
  NovaProxy,
  NovaProxyProtocol,
  NovaRule,
  NovaState,
  ProviderAccountRecord,
  ProviderNetworkSnapshot,
  ProxyPolicyMode,
} from "../types";
import { localText, messageOf } from "./execution-surface-utils";
import "./orchestration-control.css";
import "./network-proxy.css";

// The Proxy page is ProxyBridge Nova's dashboard. Nova owns the proxies, rules and system routing;
// Coding Tools' routes (app-wide, CPA, provider, account) pick from Nova's proxies and its gateway.

const MODES: readonly ProxyPolicyMode[] = ["inherit", "global", "direct", "profile"];
const PROXY_PATH_PROVIDERS = new Set(["claude-oauth", "anthropic-api"]);
const LIVE_REFRESH_MS = 2_000;

type NovaTab = "proxies" | "rules" | "apps" | "connections" | "log" | "decodo";

interface ProxyDraft {
  key: string;
  protocol: NovaProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  upstreamEligible: boolean;
}

interface RuleDraft {
  name: string;
  executables: string;
  action: NovaRule["action"];
  proxyKey: string;
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

function routingLabel(language: Language, state: string | undefined): string {
  switch (state) {
    case "active":
      return localText(language, "Routing on", "路由已啟用", "路由已启用", "ルーティング中");
    case "direct":
      return localText(language, "Routing off (direct)", "路由已停用（直接連線）", "路由已停用（直接连接）", "ルーティング停止（直接接続）");
    case "starting":
      return localText(language, "Starting routing…", "正在啟用路由…", "正在启用路由…", "ルーティングを開始中…");
    case "stopping":
      return localText(language, "Stopping routing…", "正在停止路由…", "正在停止路由…", "ルーティングを停止中…");
    case "setupRequired":
      return localText(language, "Routing needs a one-time setup", "路由需要一次性安裝", "路由需要一次性安装", "ルーティングの初回セットアップが必要");
    case "disabled":
      return localText(language, "Routing disabled", "路由已停用", "路由已停用", "ルーティング無効");
    case "error":
      return localText(language, "Routing error", "路由錯誤", "路由错误", "ルーティングエラー");
    default:
      return "—";
  }
}

function appStateLabel(language: Language, state: NovaApp["state"]): string {
  switch (state) {
    case "connected":
      return localText(language, "Connected", "已連線", "已连接", "接続中");
    case "idle":
      return localText(language, "Running, idle", "執行中・閒置", "运行中・空闲", "実行中・待機");
    case "notRunning":
      return localText(language, "Not running", "未執行", "未运行", "未実行");
    case "disabled":
      return localText(language, "Disabled", "已停用", "已停用", "無効");
  }
}

function proxyLabel(proxy: Pick<NovaProxy, "protocol" | "host" | "port" | "provider">): string {
  const where = `${proxy.protocol.toUpperCase()} ${proxy.host}:${proxy.port}`;
  return proxy.provider ? `${proxy.provider} · ${where}` : where;
}

function emptyProxy(): ProxyDraft {
  return { key: "", protocol: "socks5", host: "", port: "", username: "", password: "", upstreamEligible: true };
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
  const [nova, setNova] = useState<NovaState | null>(null);
  const [profile, setProfile] = useState<NovaProfile | null>(null);
  const [tab, setTab] = useState<NovaTab>("proxies");
  const [proxyDraft, setProxyDraft] = useState<ProxyDraft>(emptyProxy);
  const [rules, setRules] = useState<NovaRule[] | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>({ name: "", executables: "", action: "proxy", proxyKey: "" });
  const [apps, setApps] = useState<NovaApp[]>([]);
  const [connections, setConnections] = useState<NovaConnection[]>([]);
  const [log, setLog] = useState<NovaLogEntry[]>([]);
  const [decodo, setDecodo] = useState<NovaDecodo | null>(null);
  const [decodoPassword, setDecodoPassword] = useState("");
  const [exePath, setExePath] = useState("");
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const profiles = snapshot?.proxyProfiles.filter((item) => !item.archivedAt) ?? [];
  const providers = useMemo(
    () => [...new Set(["cpa", ...(snapshot?.accounts ?? []).filter((account) => !account.archivedAt).map((account) => account.providerId)])],
    [snapshot],
  );
  const running = nova?.running === true;
  const routing = nova?.status?.routing;
  const eligible = (profile?.proxies ?? []).filter((proxy) => proxy.upstreamEligible);

  const loadProfile = useCallback(async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const next = await api.novaProfile();
    setProfile(next);
    setRules(null);
  }, []);

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.providerSnapshot(), api.externalServicesSnapshot(), api.novaState()]).then(([next, services, state]) => {
      if (cancelled) return;
      setSnapshot(next);
      setCpa(services.services.find((service) => service.id === "cpa") ?? null);
      setNova(state);
      setExePath(state.executable);
      if (state.running) void loadProfile().catch((cause) => setError(messageOf(cause)));
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onProviderNetworkChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const unsubscribeServices = api.onExternalServicesChanged((next) => {
      if (!cancelled) setCpa(next.services.find((service) => service.id === "cpa") ?? null);
    });
    const unsubscribeNova = api.onNovaChanged((state) => {
      if (cancelled) return;
      setNova((previous) => {
        if (state.running && previous?.status?.profile.etag !== state.status?.profile.etag) {
          void loadProfile().catch(() => {});
        }
        return state;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeServices();
      unsubscribeNova();
    };
  }, [loadProfile, setError]);

  // Applications, connections and the log change by the second: read only while their tab shows.
  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api || !running || !["apps", "connections", "log"].includes(tab)) return;
    let cancelled = false;
    let after = 0;
    const read = async () => {
      if (document.hidden) return;
      try {
        if (tab === "apps") {
          const result = await api.novaApps();
          if (!cancelled) setApps(result.apps);
        } else if (tab === "connections") {
          const result = await api.novaConnections();
          if (!cancelled) setConnections(result.connections);
        } else {
          const result = await api.novaLog(after);
          if (cancelled || !result.entries.length) return;
          after = result.entries.at(-1)!.seq;
          setLog((current) => [...current, ...result.entries].slice(-300));
        }
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    };
    setLog([]);
    void read();
    const timer = window.setInterval(() => void read(), LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running, setError, tab]);

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api || !running || tab !== "decodo") return;
    void api.novaDecodo().then(setDecodo).catch((cause) => setError(messageOf(cause)));
  }, [running, setError, tab]);

  const act = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (success) setNotice(success);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const startNova = () => act(async () => {
    const api = window.codexWebLauncher!;
    if (exePath.trim() && exePath.trim() !== nova?.executable) setNova(await api.novaSetExecutable(exePath.trim()));
    setNova(await api.novaStart());
    await loadProfile();
  }, localText(language, "ProxyBridge Nova is running.", "ProxyBridge Nova 已執行。", "ProxyBridge Nova 已运行。", "ProxyBridge Nova を起動しました。"));

  const routingAction = (action: "start" | "stop" | "install") => act(
    () => window.codexWebLauncher!.novaRouting(action),
    action === "stop"
      ? localText(language, "Stopping routing.", "正在停止路由。", "正在停止路由。", "ルーティングを停止しています。")
      : action === "install"
        ? localText(language, "Approve the Windows prompt to finish the setup.", "請喺 Windows 提示中允許以完成安裝。", "请在 Windows 提示中允许以完成安装。", "Windows の確認画面で許可してセットアップを完了してください。")
        : localText(language, "Starting routing.", "正在啟用路由。", "正在启用路由。", "ルーティングを開始しています。"),
  );

  const saveProxies = (proxies: NovaProxy[], success: string) => act(async () => {
    const next = await window.codexWebLauncher!.novaSaveProxies({ etag: profile?.etag ?? "", proxies });
    setProfile(next);
  }, success);

  const ownProxies = (profile?.proxies ?? []).filter((proxy) => !proxy.linked).map((proxy) => ({ ...proxy, password: null }));

  const saveProxyDraft = () => {
    const port = Number(proxyDraft.port);
    if (!proxyDraft.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError(localText(language, "Enter a valid host and port.", "請輸入有效嘅主機同連接埠。", "请输入有效的主机和端口。", "有効なホストとポートを入力してください。"));
      return;
    }
    const entry: NovaProxy = {
      key: proxyDraft.key, protocol: proxyDraft.protocol, host: proxyDraft.host.trim(), port,
      username: proxyDraft.username, password: proxyDraft.password || (proxyDraft.key ? null : ""),
      linked: false, upstreamEligible: proxyDraft.upstreamEligible,
      provider: ownProxies.find((proxy) => proxy.key === proxyDraft.key)?.provider ?? null,
    };
    const proxies = proxyDraft.key
      ? ownProxies.map((proxy) => (proxy.key === proxyDraft.key ? entry : proxy))
      : [...ownProxies, entry];
    void saveProxies(proxies, localText(language, "Proxy saved in Nova.", "代理已儲存到 Nova。", "代理已保存到 Nova。", "プロキシを Nova に保存しました。"))
      .then(() => setProxyDraft(emptyProxy()));
  };

  const removeProxy = (key: string) => void saveProxies(
    ownProxies.filter((proxy) => proxy.key !== key),
    localText(language, "Proxy removed from Nova.", "已從 Nova 移除代理。", "已从 Nova 移除代理。", "Nova からプロキシを削除しました。"),
  );

  const checkProxy = (key: string) => act(async () => {
    setChecks((current) => ({ ...current, [key]: "…" }));
    const result = await window.codexWebLauncher!.novaCheckProxy(key);
    setChecks((current) => ({ ...current, [key]: result.ok ? `${result.latencyMs ?? 0} ms` : result.error ?? "failed" }));
  }, localText(language, "Proxy checked.", "已檢查代理。", "已检查代理。", "プロキシを確認しました。"));

  const editedRules = rules ?? profile?.rules ?? [];
  const editRule = (ruleId: number, patch: Partial<NovaRule>) => {
    setRules(editedRules.map((rule) => (rule.ruleId === ruleId ? { ...rule, ...patch } : rule)));
  };

  const addRule = () => {
    const executables = ruleDraft.executables.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!ruleDraft.name.trim() || !executables.length) {
      setError(localText(language, "Name the rule and list at least one program.", "請為規則命名並列出至少一個程式。", "请为规则命名并列出至少一个程序。", "規則名と少なくとも 1 つのプログラムを入力してください。"));
      return;
    }
    const used = new Set(editedRules.map((rule) => rule.ruleId));
    let ruleId = 2;
    while (used.has(ruleId) && ruleId < 127) ruleId += 1;
    const rule: NovaRule = {
      ruleId, name: ruleDraft.name.trim(), enabled: true,
      applications: executables.map((executablePath) => ({ executablePath, packageFamily: null, packageSid: null, knownFamily: "none", requiresVerifiedLineage: false })),
      targetHosts: "*", targetPorts: "*", protocol: "any", action: ruleDraft.action,
      proxyKey: ruleDraft.action === "proxy" ? ruleDraft.proxyKey || eligible[0]?.key || null : null, immutable: false,
    };
    // Localhost stays first and Default last; new rules go just before Default.
    const last = editedRules.at(-1);
    setRules(last?.immutable ? [...editedRules.slice(0, -1), rule, last] : [...editedRules, rule]);
    setRuleDraft({ name: "", executables: "", action: "proxy", proxyKey: "" });
  };

  const saveRules = () => act(async () => {
    const next = await window.codexWebLauncher!.novaSaveRules({ etag: profile?.etag ?? "", rules: editedRules });
    setProfile(next);
    setRules(null);
  }, localText(language, "Rules saved in Nova.", "規則已儲存到 Nova。", "规则已保存到 Nova。", "規則を Nova に保存しました。"));

  const saveDecodo = () => act(async () => {
    if (!decodo) return;
    const next = await window.codexWebLauncher!.novaSaveDecodo({ ...decodo, password: decodoPassword || null });
    setDecodo(next);
    setDecodoPassword("");
  }, localText(language, "Decodo settings saved.", "Decodo 設定已儲存。", "Decodo 设置已保存。", "Decodo の設定を保存しました。"));

  const syncDecodo = () => act(async () => {
    const result = await window.codexWebLauncher!.novaSyncDecodo();
    setProfile(result.profile);
    setNotice(`Decodo: +${result.added} ~${result.updated} −${result.removed}`);
  }, "");

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
        throw new Error(next.outboundProxy?.error || next.error || "CPA didn't apply the proxy route. Try again.");
      }
      setNotice(localText(language,
        "CPA restarted on the selected route. Send a model request to check it.",
        "CPA 已用所選路由重新啟動。請測試模型請求以驗證外連。",
        "CPA 已使用所选路由重启。请测试模型请求以验证外连。",
        "CPA を選択した経路で再起動しました。モデル要求で送信経路を確認してください。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const proxyPathNotice = () => setNotice(localText(
    language,
    "Claude and Anthropic traffic always uses the proxy, never Direct.",
    "Claude 同 Anthropic 流量必須走代理／SOCKS，唔會改成 Direct。",
    "Claude 和 Anthropic 流量必须走代理／SOCKS，不会改为 Direct。",
    "Claude / Anthropic の通信はプロキシ/SOCKS 経路のままです。Direct にはしません。",
  ));

  const setProviderPolicy = async (providerId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const nextMode = mode === "direct" && PROXY_PATH_PROVIDERS.has(providerId) ? "inherit" : mode;
    if (nextMode !== mode) proxyPathNotice();
    await run(
      () => api.setProviderProxyPolicy({ providerId, mode: nextMode, ...(profileId ? { profileId } : {}) }),
      `${providerId}: ${policyModeLabel(language, nextMode)}`,
    );
  };

  const setAccountPolicy = async (accountId: string, mode: ProxyPolicyMode, profileId?: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    const account = snapshot?.accounts.find((candidate) => candidate.id === accountId);
    const nextMode = mode === "direct" && account && PROXY_PATH_PROVIDERS.has(account.providerId) ? "inherit" : mode;
    if (nextMode !== mode) proxyPathNotice();
    await run(
      () => api.setAccountProxyPolicy({ accountId, mode: nextMode, ...(profileId ? { profileId } : {}) }),
      `${accountId}: ${policyModeLabel(language, nextMode)}`,
    );
  };

  const globalProfileId = snapshot?.routing.globalProfileId ?? "";
  const globalProfile = profiles.find((item) => item.id === globalProfileId);
  const globalEnabled = snapshot?.routing.globalEnabled === true;
  const cpaConfigured = cpa?.status === "ready" && cpa.outboundProxy?.configMatches === true;
  const customRuleCount = (snapshot?.routing.providers.filter((rule) => rule.profileId || rule.inheritGlobal === false).length ?? 0)
    + (snapshot?.routing.accounts.filter((rule) => rule.profileId || rule.inheritGlobal === false || rule.inheritProvider === false).length ?? 0);
  const tabs: { id: NovaTab; label: string }[] = [
    { id: "proxies", label: localText(language, "Proxies", "代理", "代理", "プロキシ") },
    { id: "rules", label: localText(language, "Rules", "規則", "规则", "規則") },
    { id: "apps", label: localText(language, "Applications", "應用程式", "应用程序", "アプリ") },
    { id: "connections", label: localText(language, "Connections", "連線", "连接", "接続") },
    { id: "log", label: localText(language, "Log", "記錄", "日志", "ログ") },
    { id: "decodo", label: "Decodo" },
  ];
  const proxyOption = (key: string | null) => {
    const proxy = profile?.proxies.find((item) => item.key === key);
    return proxy ? proxyLabel(proxy) : "—";
  };

  return (
    <section className="control-surface network-proxy-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">{localText(language, "NETWORK", "網路", "网络", "ネットワーク")}</span>
          <h1>{localText(language, "Proxy", "代理", "代理", "プロキシ")}</h1>
          <p>{localText(
            language,
            "ProxyBridge Nova manages the proxies and which programs use them. The routes below pick one of its proxies for the browser, CPA, providers and accounts.",
            "ProxyBridge Nova 管理代理同邊啲程式使用佢哋。下方路由為瀏覽器、CPA、供應商同帳戶揀選 Nova 嘅代理。",
            "ProxyBridge Nova 管理代理以及哪些程序使用它们。下方路由为浏览器、CPA、供应商和账户选择 Nova 的代理。",
            "ProxyBridge Nova がプロキシと使用するプログラムを管理します。下の経路でブラウザー、CPA、プロバイダー、アカウントが使う Nova のプロキシを選びます。",
          )}</p>
        </div>
        <span className={`proxy-route-badge${running ? " is-ready" : ""}`}>
          {running
            ? `ProxyBridge Nova ${nova?.status?.version ?? ""}`.trim()
            : localText(language, "Nova not running", "Nova 未執行", "Nova 未运行", "Nova 停止中")}
        </span>
      </header>

      <section className="proxy-route-overview nova-status" aria-labelledby="nova-status-heading">
        <div className="proxy-route-header">
          <div>
            <span className="surface-kicker">PROXYBRIDGE NOVA</span>
            <h2 id="nova-status-heading">{running ? routingLabel(language, routing?.state) : localText(language, "Not running", "未執行", "未运行", "停止中")}</h2>
          </div>
          <div className="nova-actions">
            {running ? (
              <>
                {routing?.state === "setupRequired" ? (
                  <button className="primary-button compact" disabled={busy || routing.busy} onClick={() => void routingAction("install")} type="button">
                    {localText(language, "Set up routing", "安裝路由", "安装路由", "ルーティングをセットアップ")}
                  </button>
                ) : routing?.state === "active" ? (
                  <button className="secondary-button" disabled={busy || routing.busy} onClick={() => void routingAction("stop")} type="button">
                    {localText(language, "Stop routing", "停止路由", "停止路由", "ルーティングを停止")}
                  </button>
                ) : (
                  <button className="primary-button compact" disabled={busy || routing?.busy || routing?.state === "disabled"} onClick={() => void routingAction("start")} type="button">
                    {localText(language, "Start routing", "啟用路由", "启用路由", "ルーティングを開始")}
                  </button>
                )}
              </>
            ) : (
              <button className="primary-button compact" disabled={busy} onClick={() => void startNova()} type="button">
                {localText(language, "Start ProxyBridge Nova", "啟動 ProxyBridge Nova", "启动 ProxyBridge Nova", "ProxyBridge Nova を起動")}
              </button>
            )}
          </div>
        </div>
        <dl className="proxy-route-list nova-facts">
          <div><dt>{localText(language, "Gateway", "閘道", "网关", "ゲートウェイ")}</dt><dd>{nova?.status
            ? `${nova.status.gateway.host}:${nova.status.gateway.port} · ${nova.status.gateway.running
              ? localText(language, "listening", "監聽中", "监听中", "待受中")
              : nova.status.gateway.error ?? localText(language, "stopped", "已停止", "已停止", "停止")}`
            : "—"}</dd></div>
          <div><dt>{localText(language, "Proxies and rules", "代理同規則", "代理和规则", "プロキシと規則")}</dt><dd>{nova?.status
            ? `${nova.status.profile.proxyCount} · ${nova.status.profile.ruleCount}`
            : "—"}</dd></div>
          {routing?.error || nova?.error ? <div className="full-row"><dt>{localText(language, "Problem", "問題", "问题", "問題")}</dt><dd>{routing?.error ?? nova?.error}</dd></div> : null}
        </dl>
        {!running ? (
          <div className="control-fields nova-exe">
            <label className="full-row"><span>ProxyBridgeRewrite.exe</span><input value={exePath} onChange={(event) => setExePath(event.target.value)} placeholder="C:\\…\\ProxyBridgeRewrite.exe" /></label>
            <small className="proxy-secret-help">{localText(language,
              "Coding Tools runs Nova without its tray and takes over a tray that is open. Routing keeps running while it switches.",
              "Coding Tools 會喺冇系統匣嘅情況下執行 Nova，並接手已開啟嘅系統匣。切換期間路由會繼續運作。",
              "Coding Tools 会在没有托盘的情况下运行 Nova，并接管已打开的托盘。切换期间路由继续运行。",
              "Coding Tools はトレイなしで Nova を実行し、開いているトレイを引き継ぎます。切り替え中もルーティングは続きます。")}</small>
          </div>
        ) : null}
      </section>

      <section className="global-proxy-banner">
        <label className="check-row">
          <input
            checked={globalEnabled}
            disabled={busy || profiles.length === 0}
            onChange={(event) => void setGlobal(event.target.checked)}
            type="checkbox"
          />
          <span>{localText(language, "Use an app-wide proxy", "使用全應用程式代理", "使用全应用程序代理", "アプリ全体のプロキシを使用")}</span>
        </label>
        <select
          aria-label={localText(language, "App-wide proxy", "全應用程式代理", "全应用程序代理", "アプリ全体のプロキシ")}
          disabled={busy || profiles.length === 0}
          value={globalProfileId}
          onChange={(event) => void setGlobal(globalEnabled, event.target.value)}
        >
          <option value="">—</option>
          {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <small>{localText(
          language,
          "The browser switches at once. Restart CPA below to apply its route. Local connections stay on loopback.",
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
                ? (profiles.find((item) => item.id === cpa?.outboundProxy?.profileId)?.name ?? policyModeLabel(language, "direct"))
                : localText(language, "Restart to apply the saved route", "重新啟動以套用已儲存路由", "重启以应用已保存路由", "再起動して保存済みの経路を適用"))}</dd></div>
        </dl>
        <div className="proxy-route-actions">
          <button className="primary-button compact" disabled={busy || cpa?.managedInstall.state !== "installed"} onClick={() => void applyToCpa()} type="button">
            {localText(language, "Apply route to CPA", "套用路由至 CPA", "应用路由到 CPA", "CPA に経路を適用")}
          </button>
          <small>{localText(language,
            "Restarts CPA and stops its running model requests.",
            "呢個動作會重新啟動 CPA，並中斷進行中嘅 CPA 模型請求。代理可連線唔代表模型一定會回應。",
            "此操作会重启 CPA，并中断正在进行的 CPA 模型请求。代理可连接不代表模型一定能回答。",
            "CPA を再起動し、進行中のモデル要求を中断します。プロキシへの接続だけではモデルの応答は確認できません。")}</small>
        </div>
      </section>

      {running ? (
        <section className="control-panel nova-panel">
          <div className="nova-tabs" role="tablist">
            {tabs.map((item) => (
              <button aria-selected={tab === item.id} className={`nova-tab${tab === item.id ? " is-selected" : ""}`} key={item.id} onClick={() => setTab(item.id)} role="tab" type="button">{item.label}</button>
            ))}
          </div>

          {tab === "proxies" ? (
            <div className="nova-section">
              <table className="nova-table">
                <thead><tr>
                  <th>{localText(language, "Proxy", "代理", "代理", "プロキシ")}</th>
                  <th>{localText(language, "Sign-in", "登入", "登录", "認証")}</th>
                  <th>{localText(language, "Check", "檢查", "检查", "確認")}</th>
                  <th />
                </tr></thead>
                <tbody>
                  {(profile?.proxies ?? []).map((proxy) => (
                    <tr key={proxy.key}>
                      <td><strong>{proxyLabel(proxy)}</strong>{proxy.linked ? <small> · {localText(language, "linked, read-only", "已連結・唯讀", "已链接・只读", "リンク・読み取り専用")}</small> : null}{!proxy.upstreamEligible ? <small> · {localText(language, "not for routes", "唔用於路由", "不用于路由", "経路に使わない")}</small> : null}</td>
                      <td>{proxy.username ? `${proxy.username}${proxy.hasPassword ? " · ••••" : ""}` : "—"}</td>
                      <td>{checks[proxy.key] ?? ""}</td>
                      <td className="nova-row-actions">
                        <button className="secondary-button" disabled={busy} onClick={() => void checkProxy(proxy.key)} type="button">{localText(language, "Check", "檢查", "检查", "確認")}</button>
                        {!proxy.linked ? (
                          <>
                            <button className="secondary-button" disabled={busy} onClick={() => setProxyDraft({ key: proxy.key, protocol: proxy.protocol, host: proxy.host, port: String(proxy.port), username: proxy.username, password: "", upstreamEligible: proxy.upstreamEligible })} type="button">{localText(language, "Edit", "編輯", "编辑", "編集")}</button>
                            <button className="secondary-button" disabled={busy} onClick={() => removeProxy(proxy.key)} type="button">{localText(language, "Remove", "移除", "移除", "削除")}</button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!profile?.proxies.length ? <p className="empty-copy">{localText(language, "Nova has no proxies yet.", "Nova 未有代理。", "Nova 还没有代理。", "Nova にプロキシはありません。")}</p> : null}
              <h3>{proxyDraft.key
                ? localText(language, "Edit proxy", "編輯代理", "编辑代理", "プロキシを編集")
                : localText(language, "Add a proxy", "新增代理", "新增代理", "プロキシを追加")}</h3>
              <div className="control-fields proxy-fields">
                <label><span>{localText(language, "Protocol", "通訊協定", "协议", "プロトコル")}</span><select value={proxyDraft.protocol} onChange={(event) => setProxyDraft({ ...proxyDraft, protocol: event.target.value as NovaProxyProtocol })}><option value="socks5">socks5</option><option value="http">http</option><option value="https">https</option></select></label>
                <label><span>{localText(language, "Host", "主機", "主机", "ホスト")}</span><input value={proxyDraft.host} onChange={(event) => setProxyDraft({ ...proxyDraft, host: event.target.value })} /></label>
                <label><span>{localText(language, "Port", "連接埠", "端口", "ポート")}</span><input inputMode="numeric" value={proxyDraft.port} onChange={(event) => setProxyDraft({ ...proxyDraft, port: event.target.value })} /></label>
                <label><span>{localText(language, "Username", "使用者名稱", "用户名", "ユーザー名")}</span><input autoComplete="off" value={proxyDraft.username} onChange={(event) => setProxyDraft({ ...proxyDraft, username: event.target.value })} /></label>
                <label><span>{localText(language, "Password", "密碼", "密码", "パスワード")}</span><input autoComplete="off" type="password" value={proxyDraft.password} onChange={(event) => setProxyDraft({ ...proxyDraft, password: event.target.value })} /></label>
                <label className="check-row"><input checked={proxyDraft.upstreamEligible} onChange={(event) => setProxyDraft({ ...proxyDraft, upstreamEligible: event.target.checked })} type="checkbox" /><span>{localText(language, "Use for routes", "用於路由", "用于路由", "経路に使う")}</span></label>
              </div>
              {proxyDraft.key ? <p className="proxy-secret-help">{localText(language, "Leave the password blank to keep the saved one.", "密碼留空會保留已儲存密碼。", "密码留空会保留已保存的密码。", "パスワードを空欄にすると保存済みのものを維持します。")}</p> : null}
              <div className="control-actions">
                {proxyDraft.key ? <button className="secondary-button" disabled={busy} onClick={() => setProxyDraft(emptyProxy())} type="button">{localText(language, "Cancel", "取消", "取消", "キャンセル")}</button> : null}
                <button className="primary-button compact" disabled={busy} onClick={saveProxyDraft} type="button">{localText(language, "Save proxy", "儲存代理", "保存代理", "プロキシを保存")}</button>
              </div>
            </div>
          ) : null}

          {tab === "rules" ? (
            <div className="nova-section">
              <table className="nova-table">
                <thead><tr>
                  <th>{localText(language, "On", "啟用", "启用", "有効")}</th>
                  <th>{localText(language, "Rule", "規則", "规则", "規則")}</th>
                  <th>{localText(language, "Programs", "程式", "程序", "プログラム")}</th>
                  <th>{localText(language, "Action", "動作", "动作", "動作")}</th>
                  <th>{localText(language, "Proxy", "代理", "代理", "プロキシ")}</th>
                  <th />
                </tr></thead>
                <tbody>
                  {editedRules.map((rule) => (
                    <tr key={rule.ruleId}>
                      <td><input aria-label={rule.name} checked={rule.enabled} disabled={busy || rule.immutable} onChange={(event) => editRule(rule.ruleId, { enabled: event.target.checked })} type="checkbox" /></td>
                      <td><strong>{rule.name}</strong></td>
                      <td className="nova-programs">{rule.applications.length
                        ? rule.applications.map((app) => app.knownFamily !== "none" ? app.knownFamily : app.executablePath.split(/[\\/]/).pop()).join(", ")
                        : localText(language, "All programs", "所有程式", "所有程序", "すべてのプログラム")}</td>
                      <td><select disabled={busy || rule.immutable} value={rule.action} onChange={(event) => editRule(rule.ruleId, { action: event.target.value as NovaRule["action"], proxyKey: event.target.value === "proxy" ? rule.proxyKey ?? eligible[0]?.key ?? null : null })}>
                        <option value="proxy">{localText(language, "Proxy", "代理", "代理", "プロキシ")}</option>
                        <option value="direct">{localText(language, "Direct", "直接連線", "直接连接", "直接接続")}</option>
                        <option value="block">{localText(language, "Block", "封鎖", "阻止", "ブロック")}</option>
                      </select></td>
                      <td>{rule.action === "proxy"
                        ? <select disabled={busy || rule.immutable} value={rule.proxyKey ?? ""} onChange={(event) => editRule(rule.ruleId, { proxyKey: event.target.value || null })}>
                            {eligible.map((proxy) => <option key={proxy.key} value={proxy.key}>{proxyLabel(proxy)}</option>)}
                          </select>
                        : proxyOption(null)}</td>
                      <td>{!rule.immutable ? <button className="secondary-button" disabled={busy} onClick={() => setRules(editedRules.filter((item) => item.ruleId !== rule.ruleId))} type="button">{localText(language, "Remove", "移除", "移除", "削除")}</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>{localText(language, "Add a rule", "新增規則", "新增规则", "規則を追加")}</h3>
              <div className="control-fields proxy-fields">
                <label><span>{localText(language, "Name", "名稱", "名称", "名前")}</span><input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} /></label>
                <label><span>{localText(language, "Action", "動作", "动作", "動作")}</span><select value={ruleDraft.action} onChange={(event) => setRuleDraft({ ...ruleDraft, action: event.target.value as NovaRule["action"] })}>
                  <option value="proxy">{localText(language, "Proxy", "代理", "代理", "プロキシ")}</option>
                  <option value="direct">{localText(language, "Direct", "直接連線", "直接连接", "直接接続")}</option>
                  <option value="block">{localText(language, "Block", "封鎖", "阻止", "ブロック")}</option>
                </select></label>
                {ruleDraft.action === "proxy" ? <label><span>{localText(language, "Proxy", "代理", "代理", "プロキシ")}</span><select value={ruleDraft.proxyKey} onChange={(event) => setRuleDraft({ ...ruleDraft, proxyKey: event.target.value })}>
                  {eligible.map((proxy) => <option key={proxy.key} value={proxy.key}>{proxyLabel(proxy)}</option>)}
                </select></label> : null}
                <label className="full-row"><span>{localText(language, "Programs (one full .exe path per line)", "程式（每行一個完整 .exe 路徑）", "程序（每行一个完整 .exe 路径）", "プログラム（1 行に 1 つの .exe フルパス）")}</span><textarea rows={3} value={ruleDraft.executables} onChange={(event) => setRuleDraft({ ...ruleDraft, executables: event.target.value })} /></label>
              </div>
              <p className="proxy-secret-help">{localText(language,
                "System routing sends program traffic through SOCKS5 proxies only. Changes apply when you save; routing reloads if it is on.",
                "系統路由只會經 SOCKS5 代理轉送程式流量。儲存後先生效；如路由已啟用會重新載入。",
                "系统路由只经 SOCKS5 代理转发程序流量。保存后生效；如路由已启用会重新加载。",
                "システムルーティングはプログラムの通信を SOCKS5 プロキシ経由でのみ送ります。保存すると適用され、ルーティング中なら再読み込みします。")}</p>
              <div className="control-actions">
                <button className="secondary-button" disabled={busy} onClick={addRule} type="button">{localText(language, "Add rule", "新增規則", "新增规则", "規則を追加")}</button>
                {rules ? <button className="secondary-button" disabled={busy} onClick={() => setRules(null)} type="button">{localText(language, "Discard changes", "放棄變更", "放弃更改", "変更を破棄")}</button> : null}
                <button className="primary-button compact" disabled={busy || !rules} onClick={() => void saveRules()} type="button">{localText(language, "Save rules", "儲存規則", "保存规则", "規則を保存")}</button>
              </div>
            </div>
          ) : null}

          {tab === "apps" ? (
            <div className="nova-section">
              <table className="nova-table">
                <thead><tr>
                  <th>{localText(language, "Rule", "規則", "规则", "規則")}</th>
                  <th>{localText(language, "State", "狀態", "状态", "状態")}</th>
                  <th>PID</th>
                  <th>TCP</th>
                  <th>{localText(language, "Route", "路由", "路由", "経路")}</th>
                </tr></thead>
                <tbody>
                  {apps.map((app) => (
                    <tr key={app.ruleId}>
                      <td><strong>{app.ruleName}</strong><small className="nova-programs">{app.executables.map((exe) => exe.split(/[\\/]/).pop()).join(", ")}</small></td>
                      <td>{appStateLabel(language, app.state)}</td>
                      <td>{app.pids.join(", ") || "—"}</td>
                      <td>{app.tcpCount}</td>
                      <td>{app.proxyLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!apps.length ? <p className="empty-copy">{localText(language, "No rule names a program.", "未有規則指定程式。", "没有规则指定程序。", "プログラムを指定した規則はありません。")}</p> : null}
            </div>
          ) : null}

          {tab === "connections" ? (
            <div className="nova-section">
              <table className="nova-table">
                <thead><tr>
                  <th>{localText(language, "Program", "程式", "程序", "プログラム")}</th>
                  <th>PID</th>
                  <th>{localText(language, "Target", "目標", "目标", "接続先")}</th>
                  <th>{localText(language, "State", "狀態", "状态", "状態")}</th>
                  <th>{localText(language, "Route", "路由", "路由", "経路")}</th>
                </tr></thead>
                <tbody>
                  {connections.map((connection) => (
                    <tr key={connection.id}>
                      <td>{connection.application}</td>
                      <td>{connection.pid}</td>
                      <td>{connection.target}</td>
                      <td>{connection.state}</td>
                      <td>{connection.route}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!connections.length ? <p className="empty-copy">{localText(language, "No connections from routed programs.", "受路由程式未有連線。", "受路由程序没有连接。", "ルーティング対象のプログラムに接続はありません。")}</p> : null}
            </div>
          ) : null}

          {tab === "log" ? (
            <div className="nova-section">
              <ol className="nova-log">
                {log.map((entry) => (
                  <li className={entry.level === "error" ? "is-error" : undefined} key={entry.seq}>
                    <time>{new Date(entry.at).toLocaleTimeString()}</time> {entry.text}
                  </li>
                ))}
              </ol>
              {!log.length ? <p className="empty-copy">{localText(language, "Nothing logged yet.", "未有記錄。", "还没有日志。", "ログはまだありません。")}</p> : null}
            </div>
          ) : null}

          {tab === "decodo" ? (
            <div className="nova-section">
              {decodo ? (
                <>
                  <div className="control-fields proxy-fields">
                    <label><span>{localText(language, "Username", "使用者名稱", "用户名", "ユーザー名")}</span><input autoComplete="off" value={decodo.username} onChange={(event) => setDecodo({ ...decodo, username: event.target.value })} /></label>
                    <label><span>{localText(language, "Password", "密碼", "密码", "パスワード")}</span><input autoComplete="off" placeholder={decodo.hasPassword ? "••••" : ""} type="password" value={decodoPassword} onChange={(event) => setDecodoPassword(event.target.value)} /></label>
                    <label><span>{localText(language, "Country", "國家", "国家", "国")}</span><input value={decodo.country} onChange={(event) => setDecodo({ ...decodo, country: event.target.value })} /></label>
                    <label><span>{localText(language, "Proxies", "代理數量", "代理数量", "プロキシ数")}</span><input inputMode="numeric" value={String(decodo.count)} onChange={(event) => setDecodo({ ...decodo, count: Number(event.target.value) || 0 })} /></label>
                    <label><span>{localText(language, "Session (minutes)", "工作階段（分鐘）", "会话（分钟）", "セッション（分）")}</span><input inputMode="numeric" value={String(decodo.sessionMinutes)} onChange={(event) => setDecodo({ ...decodo, sessionMinutes: Number(event.target.value) || 0 })} /></label>
                    <label><span>{localText(language, "Refresh (minutes)", "重新整理（分鐘）", "刷新（分钟）", "更新（分）")}</span><input inputMode="numeric" value={String(decodo.refreshMinutes)} onChange={(event) => setDecodo({ ...decodo, refreshMinutes: Number(event.target.value) || 0 })} /></label>
                    <label><span>{localText(language, "Protocol", "通訊協定", "协议", "プロトコル")}</span><select value={decodo.protocol} onChange={(event) => setDecodo({ ...decodo, protocol: event.target.value as NovaProxyProtocol })}><option value="socks5">socks5</option><option value="http">http</option><option value="https">https</option></select></label>
                    <label className="check-row"><input checked={decodo.autoSync} onChange={(event) => setDecodo({ ...decodo, autoSync: event.target.checked })} type="checkbox" /><span>{localText(language, "Sync automatically", "自動同步", "自动同步", "自動で同期")}</span></label>
                  </div>
                  <p className="proxy-secret-help">{decodo.lastError
                    ?? (decodo.lastSyncAt
                      ? `${localText(language, "Last synced", "上次同步", "上次同步", "前回の同期")} ${new Date(decodo.lastSyncAt).toLocaleString()}`
                      : localText(language, "Not synced yet.", "未同步。", "尚未同步。", "未同期です。"))}</p>
                  <div className="control-actions">
                    <button className="secondary-button" disabled={busy} onClick={() => void syncDecodo()} type="button">{localText(language, "Sync now", "立即同步", "立即同步", "今すぐ同期")}</button>
                    <button className="primary-button compact" disabled={busy} onClick={() => void saveDecodo()} type="button">{localText(language, "Save", "儲存", "保存", "保存")}</button>
                  </div>
                </>
              ) : <p className="empty-copy">…</p>}
            </div>
          ) : null}
        </section>
      ) : null}

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
            return <div className="policy-row" key={providerId}><strong>{providerId}</strong><select disabled={busy} value={mode} onChange={(event) => void setProviderPolicy(providerId, event.target.value as ProxyPolicyMode, policy?.profileId)}>{MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}</select><select disabled={busy || mode !== "profile"} value={policy?.profileId ?? ""} onChange={(event) => void setProviderPolicy(providerId, "profile", event.target.value)}><option value="">—</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>;
          })}
        </section>
        <section className="control-panel">
          <h2>{localText(language, "Account routing", "帳戶路由", "账户路由", "アカウントルーティング")}</h2>
          {(snapshot?.accounts ?? []).filter((account) => !account.archivedAt).map((account) => {
            const mode = snapshot ? accountPolicyMode(snapshot, account) : "inherit";
            const policy = snapshot?.routing.accounts.find((candidate) => candidate.accountId === account.id);
            return <div className="policy-row" key={account.id}><strong>{account.label}<small>{account.providerId}</small></strong><select disabled={busy} value={mode} onChange={(event) => void setAccountPolicy(account.id, event.target.value as ProxyPolicyMode, policy?.profileId)}>{MODES.map((item) => <option key={item} value={item}>{policyModeLabel(language, item)}</option>)}</select><select disabled={busy || mode !== "profile"} value={policy?.profileId ?? account.proxyProfileId ?? ""} onChange={(event) => void setAccountPolicy(account.id, "profile", event.target.value)}><option value="">—</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>;
          })}
        </section>
      </div>
      </details>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}
