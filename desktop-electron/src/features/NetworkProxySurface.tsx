import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  EgressRoute,
  EgressStatus,
  EgressTargetStatus,
  ExternalServiceSnapshot,
  Language,
  ProviderNetworkSnapshot,
  ProxyPolicyMode,
  ProxyProfileInput,
  ProxyProfileRecord,
  ProxyProtocol,
} from "../types";
import { localText, messageOf } from "./execution-surface-utils";
import "./network-proxy.css";

// The Proxy page (docs/specs/rewrite-the-proxy). Every byte the app and the programs it starts send
// goes through the app's egress router, which takes each connection's route: the App route (Global
// Routing) for the app itself, a route per model provider or per CPA account for model traffic. The
// page says what goes where right now, whether each proxy works, and what follows it.

const PROXY_PATH_PROVIDERS = new Set(["claude-oauth", "anthropic-api"]);
const PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5", "socks4"];
const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1", "*.localhost"];
// The app's older provider ids for CPA's provider types (egress-routes.cjs keeps the same list).
const PROVIDER_ALIASES: Record<string, string> = { "codex-oauth": "codex", "claude-oauth": "claude", "anthropic-api": "claude", "gemini-oauth": "gemini", "cliproxyapi-antigravity": "antigravity" };
const KNOWN_PROVIDERS = ["codex", "claude", "gemini", "antigravity", "provider-manager"];
const PROVIDER_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini", antigravity: "Antigravity", "provider-manager": "Provider Manager", vertex: "Vertex", qwen: "Qwen", iflow: "iFlow", aistudio: "AI Studio" };
const STATUS_POLL_MS = 3_000;
const CREDENTIALS_SHOWN = 40;

interface Draft {
  id?: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  hasAuthentication: boolean;
}

const emptyDraft = (): Draft => ({ name: "", protocol: "http", host: "", port: "", username: "", password: "", hasAuthentication: false });
// Editing shows the saved username; the password stays blank and is kept unless one is typed.
const draftOf = (profile: ProxyProfileRecord): Draft => ({
  id: profile.id, name: profile.name, protocol: profile.endpoint.protocol, host: profile.endpoint.host, port: String(profile.endpoint.port),
  username: profile.username ?? "", password: "", hasAuthentication: profile.hasAuthentication,
});

/** A proxy as one line, for the route pickers: name, address and, when it signs in, its username. */
const profileLabel = (profile: ProxyProfileRecord) =>
  [profile.name, `${profile.endpoint.host}:${profile.endpoint.port}`, profile.username].filter(Boolean).join(" · ");

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

/** What a route picker offers besides the proxies: Follow (the level above) or Direct. */
function policyModeLabel(language: Language, mode: ProxyPolicyMode | "follow"): string {
  switch (mode) {
    case "inherit":
    case "follow": return localText(language, "Follow", "跟上層", "跟随上层", "上位に従う");
    case "global": return localText(language, "App route", "App 路由", "App 路由", "アプリの経路");
    case "direct": return localText(language, "Direct", "直接連線", "直接连接", "直接接続");
    case "profile": return localText(language, "Proxy", "指定代理", "指定代理", "プロキシ");
  }
}

const providerType = (providerId: string) => PROVIDER_ALIASES[providerId] ?? providerId;
const providerName = (type: string) => type === "cpa" ? "" : PROVIDER_NAMES[type] ?? type.replace(/(^|[-_ ])([a-z])/g, (_all, gap: string, letter: string) => `${gap ? " " : ""}${letter.toUpperCase()}`);
const mayGoDirect = (type: string) => !PROXY_PATH_PROVIDERS.has(type) && type !== "claude";

function ago(language: Language, when: string | number | undefined | null): string {
  const at = typeof when === "number" ? when : when ? Date.parse(when) : NaN;
  if (!Number.isFinite(at) || at <= 0) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return localText(language, "just now", "啱啱", "刚刚", "たった今");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return localText(language, `${minutes} min ago`, `${minutes} 分鐘前`, `${minutes} 分钟前`, `${minutes} 分前`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return localText(language, `${hours} h ago`, `${hours} 小時前`, `${hours} 小时前`, `${hours} 時間前`);
  return localText(language, `${Math.round(hours / 24)} d ago`, `${Math.round(hours / 24)} 日前`, `${Math.round(hours / 24)} 天前`, `${Math.round(hours / 24)} 日前`);
}

const Glyph = ({ d }: { d: string }) => (
  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15"><path d={d} /></svg>
);
const PULSE = "M3 12h4l3-8 4 16 3-8h4";
const PEN = "M4 20h4L19 9l-4-4L4 16v4z";
const BIN = "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13";
const PLUS = "M12 5v14M5 12h14";
const PERSON = "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0";
const LOOP = "M4 12a8 8 0 0 1 14-5l2-2v6h-6l2-2a5 5 0 1 0 1 6";

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
  const [egress, setEgress] = useState<EgressStatus | null>(null);
  const [replacing, setReplacing] = useState<{ profileId: string; replacement: string } | null>(null);
  const [credentialFilter, setCredentialFilter] = useState("");
  const [loadError, setLoadError] = useState("");
  const [showAllCredentials, setShowAllCredentials] = useState(false);
  const deleteTimer = useRef<number | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);

  const profiles = snapshot?.proxyProfiles.filter((profile) => !profile.archivedAt) ?? [];
  const globalOn = snapshot?.routing.globalEnabled === true;
  const activeId = snapshot?.routing.globalProfileId ?? "";
  const activeProfile = profiles.find((profile) => profile.id === activeId) ?? null;
  const cpaInstalled = cpa?.managedInstall.state === "installed";
  const cpaOnRoute = cpa?.status === "ready" && cpa.outboundProxy?.configMatches === true;
  const targets = useMemo(() => new Map((egress?.targets ?? []).map((entry) => [entry.target, entry])), [egress]);

  const load = (api: NonNullable<typeof window.codexWebLauncher>, isCancelled: () => boolean) => {
    setLoadError("");
    void Promise.all([api.providerSnapshot(), api.externalServicesSnapshot()]).then(([next, services]) => {
      if (isCancelled()) return;
      setSnapshot(next);
      setCpa(services.services.find((service) => service.id === "cpa") ?? null);
    }).catch((cause) => { if (!isCancelled()) setLoadError(messageOf(cause)); });
  };

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api) return;
    let cancelled = false;
    load(api, () => cancelled);
    const unsubscribe = api.onProviderNetworkChanged((next) => { if (!cancelled) setSnapshot(next); });
    const unsubscribeServices = api.onExternalServicesChanged((next) => {
      if (!cancelled) setCpa(next.services.find((service) => service.id === "cpa") ?? null);
    });
    return () => { cancelled = true; unsubscribe(); unsubscribeServices(); };
  }, [setError]);

  // The router's live view: each route and its counters, while the page is on screen.
  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api?.egressStatus) return;
    let cancelled = false;
    const refresh = () => {
      const shown = typeof document === "undefined" || (document.visibilityState === "visible" && pageRef.current?.offsetParent !== null);
      if (!shown) return;
      void api.egressStatus().then((next) => { if (!cancelled) setEgress(next); }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [snapshot]);

  useEffect(() => () => { if (deleteTimer.current) window.clearTimeout(deleteTimer.current); }, []);

  const run = async (operation: () => Promise<ProviderNetworkSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation());
      const api = window.codexWebLauncher;
      const services = await api?.externalServicesSnapshot().catch(() => null);
      if (services) setCpa(services.services.find((service) => service.id === "cpa") ?? null);
      if (api?.egressStatus) void api.egressStatus().then(setEgress).catch(() => {});
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
      name: draft.name.trim() || `${draft.protocol.toUpperCase()} ${draft.host.trim()}:${port}`,
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

  /** The routes that name a proxy: the App route, providers, CPA accounts, Browser-tab accounts. */
  const usedBy = (profileId: string) => {
    if (!snapshot) return 0;
    let count = globalOn && activeId === profileId ? 1 : 0;
    count += snapshot.routing.providers.filter((policy) => policy.profileId === profileId).length;
    count += (snapshot.routing.credentials ?? []).filter((policy) => policy.profileId === profileId).length;
    count += (egress?.targets ?? []).filter((entry) => entry.target.startsWith("browser:") && entry.policy.mode === "profile" && entry.policy.profileId === profileId).length;
    return count;
  };

  const remove = (profileId: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    // A proxy a route uses asks what those routes take instead: removing it never turns a route off.
    if (usedBy(profileId) > 0) {
      const fallback = profiles.find((profile) => profile.id !== profileId)?.id ?? "direct";
      setReplacing(replacing?.profileId === profileId ? null : { profileId, replacement: fallback });
      return;
    }
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

  const removeWithReplacement = () => {
    const api = window.codexWebLauncher;
    if (!api || !replacing) return;
    const { profileId, replacement } = replacing;
    setReplacing(null);
    if (draft?.id === profileId) setDraft(null);
    void run(() => api.archiveProxyProfile(profileId, { replacement }));
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
        throw new Error(next.outboundProxy?.error || next.error || "CPA didn't take the app's proxy router. Try again.");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  // A route picker's value: "follow", "direct" or a proxy's id.
  const providerPolicy = (type: string) => {
    const policies = snapshot?.routing.providers ?? [];
    return policies.find((policy) => policy.providerId === type) ?? policies.find((policy) => providerType(policy.providerId) === type);
  };
  const providerValue = (type: string) => {
    const policy = providerPolicy(type);
    if (policy?.profileId) return policy.profileId;
    return policy?.inheritGlobal === false ? "direct" : "follow";
  };
  const setProviderRoute = (type: string, value: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    // Claude and Anthropic traffic always goes through a proxy, never Direct.
    if (value === "direct" && !mayGoDirect(type)) return;
    const mode: ProxyPolicyMode = value === "follow" ? "inherit" : value === "direct" ? "direct" : "profile";
    void run(() => api.setProviderProxyPolicy({ providerId: type, mode, ...(mode === "profile" ? { profileId: value } : {}) }));
  };
  const credentialValue = (name: string) => {
    const policy = (snapshot?.routing.credentials ?? []).find((item) => item.authName === name);
    if (!policy || policy.mode === "follow") return "follow";
    return policy.mode === "direct" ? "direct" : policy.profileId ?? "follow";
  };
  const setCredentialRoute = (name: string, provider: string, value: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    if (value === "direct" && !mayGoDirect(provider)) return;
    const mode = value === "follow" ? "follow" : value === "direct" ? "direct" : "profile";
    void run(() => api.setCredentialProxyPolicy({ authName: name, provider, mode, ...(mode === "profile" ? { profileId: value } : {}) }));
  };
  const reconnect = (target: string) => {
    const api = window.codexWebLauncher;
    if (!api) return;
    void api.reconnectProxyTarget(target).then(() => api.egressStatus?.().then(setEgress)).catch((cause) => setError(messageOf(cause)));
  };

  /** A route picker's words for Follow and Direct. */
  const choice = (item: ProxyPolicyMode | "follow") => policyModeLabel(language, item);

  // ---- words -------------------------------------------------------------------------------
  const health = (profile: ProxyProfileRecord) => {
    if (testing.has(profile.id)) return { tone: "is-testing", text: "" };
    // The proxy answered and refused its sign-in: "Unreachable" sent people to check the address.
    if (profile.signInRefused) return { tone: "is-down", text: t("Sign-in refused", "登入被拒", "登录被拒", "サインイン拒否") };
    if (profile.lastError) return { tone: "is-down", text: t("Unreachable", "連唔到", "无法连接", "接続不可") };
    if (profile.latencyMs !== undefined) return { tone: profile.latencyMs > 800 ? "is-slow" : "is-up", text: `${profile.latencyMs} ms` };
    return { tone: "", text: "" };
  };
  /** One line under a proxy: its last test (when, exit IP and country) or why it failed. */
  const facts = (profile: ProxyProfileRecord) => {
    if (testing.has(profile.id)) return t("Testing the sign-in and the exit…", "測試緊登入同出口…", "正在测试登录和出口…", "サインインと出口をテスト中…");
    const when = ago(language, profile.lastCheckedAt);
    if (profile.signInRefused) return [t("The proxy refused the saved username and password", "代理拒絕咗儲存咗嘅帳號密碼", "代理拒绝了保存的用户名和密码", "保存したユーザー名とパスワードが拒否されました"), when].filter(Boolean).join(" · ");
    if (profile.lastError) return [profile.lastError, when].filter(Boolean).join(" · ");
    if (profile.latencyMs === undefined) return t("Not tested yet", "未測試", "尚未测试", "未テスト");
    const exit = profile.exitIp ? `${t("exit", "出口", "出口", "出口")} ${profile.exitIp}${profile.exitCountry ? ` (${profile.exitCountry})` : ""}` : "";
    return [t("Signs in and connects", "登入同連線正常", "登录和连接正常", "接続できます"), exit, when].filter(Boolean).join(" · ");
  };
  const routeWords = (value: EgressRoute | undefined | null) => {
    if (!value) return t("Not set up yet", "未設定", "尚未设置", "未設定");
    if (value.mode === "direct") return t("Direct", "直接連線", "直接连接", "直接接続");
    if (value.mode === "broken") return `${t("Blocked", "已封鎖", "已阻止", "ブロック")}: ${value.reason}`;
    const profile = profiles.find((item) => item.id === value.profileId);
    return profile ? profile.name : `${value.host}:${value.port}`;
  };
  const statWords = (entry: EgressTargetStatus | undefined) => {
    const stats = entry?.stats;
    if (!stats) return "";
    const parts: string[] = [];
    if (stats.open) parts.push(t(`${stats.open} open`, `${stats.open} 條連線`, `${stats.open} 个连接`, `${stats.open} 接続`));
    if (stats.lastErrorAt && stats.lastErrorAt >= (stats.lastOkAt || 0)) parts.push(`${t("failed", "失敗", "失败", "失敗")} ${ago(language, stats.lastErrorAt)}: ${stats.lastError}`);
    else if (stats.lastOkAt) parts.push(`${t("last used", "最近使用", "最近使用", "最終使用")} ${ago(language, stats.lastOkAt)}`);
    return parts.join(" · ");
  };
  const fromWords = (entry: EgressTargetStatus | undefined) => {
    if (!entry || entry.from === entry.target) return "";
    if (entry.from === "app") return t("follows the App route", "跟 App 路由", "跟随 App 路由", "アプリの経路に従う");
    if (entry.from === "cpa") return t("follows All model providers", "跟全部模型供應商", "跟随全部模型提供商", "全モデルプロバイダーに従う");
    if (entry.from.startsWith("provider:")) return t(`follows ${providerName(entry.from.slice(9))}`, `跟 ${providerName(entry.from.slice(9))}`, `跟随 ${providerName(entry.from.slice(9))}`, `${providerName(entry.from.slice(9))} に従う`);
    return "";
  };

  // ---- what to list ----------------------------------------------------------------------------
  const providerTypes = useMemo(() => {
    const types = new Set(KNOWN_PROVIDERS);
    for (const policy of snapshot?.routing.providers ?? []) if (policy.providerId !== "cpa") types.add(providerType(policy.providerId));
    for (const credential of egress?.credentials ?? []) if (credential.provider) types.add(credential.provider);
    return [...types];
  }, [snapshot, egress]);
  const credentials = useMemo(() => {
    const query = credentialFilter.trim().toLowerCase();
    const all = (egress?.credentials ?? []).filter((credential) => !query
      || [credential.name, credential.label ?? "", credential.provider].some((value) => value.toLowerCase().includes(query)));
    return all.sort((a, b) => (a.provider + (a.label || a.name)).localeCompare(b.provider + (b.label || b.name)));
  }, [egress, credentialFilter]);
  const ownCredentialRoutes = (snapshot?.routing.credentials ?? []).length;
  const customRoutes = (snapshot?.routing.providers.filter((rule) => rule.profileId || rule.inheritGlobal === false).length ?? 0) + ownCredentialRoutes;
  const browserTargets = (egress?.targets ?? []).filter((entry) => entry.target.startsWith("browser:"));
  const appEntry = targets.get("app");
  const router = egress?.router;

  const summary = !snapshot ? "" : globalOn
    ? activeProfile
      ? t(`All app traffic goes through ${activeProfile.name}.`, `全部 App 連線經 ${activeProfile.name}。`, `全部 App 连接经 ${activeProfile.name}。`, `アプリの通信はすべて ${activeProfile.name} 経由です。`)
      : t("Global Routing names a proxy that's gone: app traffic is blocked until you pick one.", "全域路由指定嘅代理已經冇咗：揀返一個之前 App 連線會被封鎖。", "全局路由指定的代理已不存在：选择新代理前 App 连接会被阻止。", "グローバル経路のプロキシがありません。選ぶまで通信はブロックされます。")
    : t("Direct: the app connects without a proxy. Model providers and accounts with a route of their own still use theirs.", "直接連線：App 唔經代理。有自己路由嘅模型供應商同帳號照用佢哋嘅。", "直接连接：App 不经代理。有自己路由的模型提供商和账号仍使用各自的路由。", "直接接続：アプリはプロキシを使いません。独自の経路を持つプロバイダーとアカウントはそれを使います。");

  const editor = (key: string) => draft ? (
    <form className="px-editor" key={key} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="px-protocols" role="radiogroup" aria-label={t("Protocol", "通訊協定", "协议", "プロトコル")}>
        {PROTOCOLS.map((protocol) => (
          <button aria-checked={draft.protocol === protocol} className={draft.protocol === protocol ? "is-on" : ""} key={protocol}
            onClick={() => setDraft({ ...draft, protocol })} role="radio" type="button">{protocol.toUpperCase()}</button>
        ))}
      </div>
      <label className="px-name-field">
        <span>{t("Proxy name", "代理名稱", "代理名称", "プロキシ名")}</span>
        <input autoComplete="off" aria-label={t("Proxy name", "代理名稱", "代理名称", "プロキシ名")} maxLength={160}
          placeholder={t("Optional name", "名稱（可選）", "名称（可选）", "名前（任意）")} value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <div className="px-fields px-endpoint-fields">
        <input aria-label={t("Host", "主機", "主机", "ホスト")} autoFocus className="px-host" placeholder={t("host, or paste a proxy URL", "主機，或者貼上代理網址", "主机，或粘贴代理网址", "ホスト、またはプロキシ URL を貼り付け")} value={draft.host}
          onChange={(event) => setDraft(pastedProxy(event.target.value, draft) ?? { ...draft, host: event.target.value })} />
        <input aria-label={t("Port", "連接埠", "端口", "ポート")} className="px-port" inputMode="numeric" placeholder="port" value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: event.target.value.replace(/\D/g, "").slice(0, 5) })} />
      </div>
      <div className="px-fields px-credential-fields">
        <input aria-label={t("Username", "使用者名稱", "用户名", "ユーザー名")} autoComplete="off"
          placeholder={t("username (optional)", "使用者名稱（可選）", "用户名（可选）", "ユーザー名（任意）")}
          value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
        <input aria-label={t("Password", "密碼", "密码", "パスワード")} autoComplete="off" type="password"
          placeholder={draft.hasAuthentication ? t("saved; type to change", "已儲存；輸入新嘅就會更改", "已保存；输入新的即可更改", "保存済み。入力すると変更") : t("password", "密碼", "密码", "パスワード")}
          value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
      </div>
      <div className="px-editor-actions">
        <button className="px-ghost" onClick={() => setDraft(null)} type="button">{t("Cancel", "取消", "取消", "キャンセル")}</button>
        <button className="px-primary" disabled={busy} type="submit">{t("Save", "儲存", "保存", "保存")}</button>
      </div>
    </form>
  ) : null;

  return (
    <section className={`px-page${globalOn ? " is-on" : ""}`} ref={pageRef}>
      <header className="px-head">
        <div className="px-title">
          <h1>{t("Proxy", "代理", "代理", "プロキシ")}</h1>
          <p className="px-summary">{summary}</p>
        </div>
        <button aria-checked={globalOn} aria-label={t("Route the app through the proxy", "經代理連線", "经代理连接", "プロキシ経由で接続")}
          className={`switch${globalOn ? " is-on" : ""}`} disabled={busy || profiles.length === 0} role="switch" type="button"
          onClick={() => route(!globalOn, activeId || profiles[0]?.id || null)}><span /></button>
      </header>

      {loadError ? (
        <div className="px-alert" role="alert">
          <span>{t("Couldn't load the proxy settings", "載入唔到代理設定", "无法载入代理设置", "プロキシ設定を読み込めません")}: {loadError}</span>
          <button className="px-ghost" onClick={() => { const api = window.codexWebLauncher; if (api) load(api, () => false); }} type="button">{t("Retry", "再試", "重试", "再試行")}</button>
        </div>
      ) : null}
      {snapshot?.error ? <div className="px-alert" role="alert"><span>{snapshot.error}</span></div> : null}
      {router && !router.running ? (
        <div className="px-alert" role="alert">
          <span>{t("The app's proxy router isn't running, so routed traffic is blocked (never sent direct)", "App 嘅代理路由器冇運行，經代理嘅連線會被封鎖（唔會直接連線）", "App 的代理路由器未运行，经代理的连接会被阻止（不会直接连接）", "アプリのプロキシルーターが停止中のため、経路付きの通信はブロックされます")}{router.error ? `: ${router.error}` : ""}</span>
        </div>
      ) : null}
      {router?.portMovedAt ? (
        <div className="px-alert is-warn" role="status">
          <span>{t(`The proxy router moved to port ${router.port} ${ago(language, router.portMovedAt)}. Programs started before then (agents, CPA) need a restart to follow it.`, `代理路由器 ${ago(language, router.portMovedAt)} 轉咗去連接埠 ${router.port}。之前開嘅程式（Agent、CPA）要重新開先會跟。`, `代理路由器 ${ago(language, router.portMovedAt)} 改用端口 ${router.port}。之前启动的程序（Agent、CPA）需要重启才会跟随。`, `プロキシルーターは ${ago(language, router.portMovedAt)} にポート ${router.port} へ移りました。それ以前に起動したプログラムは再起動が必要です。`)}</span>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="px-list" aria-busy="true">{[0, 1].map((index) => <div className="px-card is-skeleton" key={index} />)}</div>
      ) : (
        <div className="px-list" role="radiogroup" aria-label={t("Proxies", "代理", "代理", "プロキシ")}>
          {profiles.map((profile, index) => {
            const active = profile.id === activeId;
            const state = health(profile);
            const uses = usedBy(profile.id);
            const failing = Boolean(profile.signInRefused || profile.lastError);
            return (
              <div className="px-item" key={profile.id} style={{ "--i": index } as CSSProperties}>
                <div className={`px-card${active ? " is-active" : ""}`}>
                  <button aria-checked={active} className="px-pick" disabled={busy} role="radio" type="button"
                    onClick={() => route(globalOn, profile.id)}>
                    <span className="px-radio" />
                    <span className="px-proto">{profile.endpoint.protocol}</span>
                    <span className="px-identity">
                      <span className="px-name" title={profile.name}>{profile.name}</span>
                      <span className="px-addr" title={`${profile.endpoint.host}:${profile.endpoint.port}`}>{profile.endpoint.host}<em>:{profile.endpoint.port}</em></span>
                      {profile.username ? (
                        <span className="px-user" title={`${t("Username", "使用者名稱", "用户名", "ユーザー名")}: ${profile.username}`}>
                          <Glyph d={PERSON} /><span>{profile.username}</span>
                        </span>
                      ) : null}
                      <span className={`px-facts${failing ? " is-bad" : ""}`}>{facts(profile)}</span>
                    </span>
                    {uses ? <span className="px-used" title={t("Routes that use this proxy", "用緊呢個代理嘅路由", "使用此代理的路由", "このプロキシを使う経路")}>{t(`${uses} route${uses === 1 ? "" : "s"}`, `${uses} 條路由`, `${uses} 条路由`, `経路 ${uses}`)}</span> : null}
                  </button>
                  <span className={`px-health ${state.tone}`} title={profile.lastError ?? undefined}><i />{state.text}</span>
                  <div className="px-tools">
                    <button aria-label={t("Test", "測試", "测试", "テスト")} disabled={testing.has(profile.id)} onClick={() => void test(profile.id)} title={t("Test the sign-in and where it exits", "測試登入同出口", "测试登录和出口", "サインインと出口をテスト")} type="button"><Glyph d={PULSE} /></button>
                    <button aria-label={t("Edit", "編輯", "编辑", "編集")} onClick={() => setDraft(draft?.id === profile.id ? null : draftOf(profile))} type="button"><Glyph d={PEN} /></button>
                    <button aria-label={t("Remove", "移除", "移除", "削除")} className={confirmDelete === profile.id || replacing?.profileId === profile.id ? "is-confirm" : ""} onClick={() => remove(profile.id)} type="button"><Glyph d={BIN} /></button>
                  </div>
                </div>
                {replacing?.profileId === profile.id ? (
                  <div className="px-replace" role="group" aria-label={t("Remove this proxy", "移除呢個代理", "移除此代理", "このプロキシを削除")}>
                    <span>{t(`${uses} route${uses === 1 ? " uses" : "s use"} this proxy. Move ${uses === 1 ? "it" : "them"} to:`, `有 ${uses} 條路由用緊呢個代理。改用：`, `有 ${uses} 条路由在使用此代理。改为：`, `${uses} 件の経路がこのプロキシを使っています。移動先：`)}</span>
                    <select value={replacing.replacement} onChange={(event) => setReplacing({ profileId: profile.id, replacement: event.target.value })}>
                      {profiles.filter((other) => other.id !== profile.id).map((other) => <option key={`move-${other.id}`} value={other.id}>{profileLabel(other)}</option>)}
                      <option value="direct">{choice("direct")}</option>
                    </select>
                    <button className="px-ghost" onClick={() => setReplacing(null)} type="button">{t("Cancel", "取消", "取消", "キャンセル")}</button>
                    <button className="px-danger" disabled={busy} onClick={removeWithReplacement} type="button">{t("Remove", "移除", "移除", "削除")}</button>
                  </div>
                ) : null}
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
          {profiles.length === 0 ? (
            <p className="px-empty">{t("Add a proxy to route the app through it. Paste a proxy URL into Host to fill every field at once.", "新增代理，App 就可以經佢連線。喺主機貼上代理網址，會一次填好所有欄位。", "添加代理即可让 App 经由它连接。在主机栏粘贴代理网址可一次填好所有字段。", "プロキシを追加するとアプリがそれを経由します。ホストに URL を貼り付けると全項目が入ります。")}</p>
          ) : null}
        </div>
      )}

      {snapshot && profiles.length ? (
        <details className="px-routes" open>
          <summary>{t("Routes", "路由", "路由", "経路")}{customRoutes ? <span>{customRoutes}</span> : null}</summary>
          <p className="px-note">{t("Each request takes the most specific route: an account's own, then its provider's, then All model providers, then the App route. A route that names a proxy that fails is blocked, never sent direct.", "每個請求用最具體嘅路由：帳號自己嘅、然後供應商嘅、然後全部模型供應商、最後 App 路由。指定嘅代理失效時會被封鎖，唔會直接連線。", "每个请求使用最具体的路由：账号自己的、然后提供商的、然后全部模型提供商、最后 App 路由。指定的代理失效时会被阻止，不会直接连接。", "各リクエストは最も具体的な経路を使います：アカウント、プロバイダー、全モデルプロバイダー、アプリの順。失敗したプロキシの経路はブロックされ、直接接続にはなりません。")}</p>
          <div className="px-route-list">
            <div className="px-route is-head">
              <strong>{t("App", "App", "App", "アプリ")}<small>{t("windows, updates, app plugins, agents and their tools", "視窗、更新、App 外掛、Agent 同佢哋嘅工具", "窗口、更新、App 插件、Agent 及其工具", "ウィンドウ、更新、プラグイン、エージェント")}</small></strong>
              <span className="px-effective">{routeWords(appEntry?.route)}<small>{statWords(appEntry)}</small></span>
              <span className="px-hint">{t("Set with the switch and the cards above", "用上面嘅開關同卡片設定", "用上方的开关和卡片设置", "上のスイッチとカードで設定")}</span>
            </div>
            {["cpa", ...providerTypes].map((type) => {
              const target = type === "cpa" ? "cpa" : `provider:${type}`;
              const entry = targets.get(target);
              const value = type === "cpa" ? (() => {
                const policy = snapshot.routing.providers.find((item) => item.providerId === "cpa");
                return policy?.profileId ? policy.profileId : policy?.inheritGlobal === false ? "direct" : "follow";
              })() : providerValue(type);
              return (
                <div className="px-route" key={target}>
                  <strong>{type === "cpa" ? t("All model providers", "全部模型供應商", "全部模型提供商", "全モデルプロバイダー") : providerName(type)}<small>{type === "cpa" ? t("CPA's default for model traffic", "CPA 模型連線嘅預設", "CPA 模型连接的默认", "CPA のモデル通信の既定") : fromWords(entry)}</small></strong>
                  <span className="px-effective">{routeWords(entry?.route)}<small>{statWords(entry)}</small></span>
                  <select aria-label={type === "cpa" ? t("All model providers", "全部模型供應商", "全部模型提供商", "全モデルプロバイダー") : providerName(type)} disabled={busy} value={value}
                    onChange={(event) => (type === "cpa" ? setProviderRoute("cpa", event.target.value) : setProviderRoute(type, event.target.value))}>
                    <option value="follow">{type === "cpa" ? t("Follow the App route", "跟 App 路由", "跟随 App 路由", "アプリの経路に従う") : choice("follow")}</option>
                    {mayGoDirect(type) ? <option value="direct">{choice("direct")}</option> : null}
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile)}</option>)}
                  </select>
                </div>
              );
            })}
          </div>

          <details className="px-sub">
            <summary>{t("Model accounts", "模型帳號", "模型账号", "モデルアカウント")}<span>{egress?.credentials.length ?? 0}</span>{ownCredentialRoutes ? <em>{t(`${ownCredentialRoutes} with their own route`, `${ownCredentialRoutes} 個有自己路由`, `${ownCredentialRoutes} 个有自己的路由`, `独自経路 ${ownCredentialRoutes}`)}</em> : null}</summary>
            {egress ? (
              <>
                <input aria-label={t("Find an account", "搵帳號", "查找账号", "アカウントを検索")} className="px-search" placeholder={t("Find by email, label or provider", "用電郵、標籤或供應商搵", "按邮箱、标签或提供商查找", "メール、ラベル、プロバイダーで検索")}
                  value={credentialFilter} onChange={(event) => setCredentialFilter(event.target.value)} />
                <div className="px-route-list">
                  {(showAllCredentials ? credentials : credentials.slice(0, CREDENTIALS_SHOWN)).map((credential) => {
                    const own = (snapshot.routing.credentials ?? []).some((item) => item.authName === credential.name);
                    const entry = targets.get(`credential:${credential.name}`) ?? targets.get(`provider:${credential.provider}`);
                    return (
                      <div className="px-route" key={credential.name}>
                        <strong title={credential.name}>{credential.label || credential.name}<small>{providerName(credential.provider) || credential.provider}{own ? "" : ` · ${fromWords(targets.get(`provider:${credential.provider}`)) || t("follows its provider", "跟佢嘅供應商", "跟随其提供商", "プロバイダーに従う")}`}</small></strong>
                        <span className="px-effective">{routeWords(entry?.route)}{own ? <small>{statWords(targets.get(`credential:${credential.name}`))}</small> : null}</span>
                        <select aria-label={credential.label || credential.name} disabled={busy} value={credentialValue(credential.name)}
                          onChange={(event) => setCredentialRoute(credential.name, credential.provider, event.target.value)}>
                          <option value="follow">{choice("follow")}</option>
                          {mayGoDirect(credential.provider) ? <option value="direct">{choice("direct")}</option> : null}
                          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile)}</option>)}
                        </select>
                      </div>
                    );
                  })}
                  {credentials.length > CREDENTIALS_SHOWN && !showAllCredentials ? (
                    <button className="px-ghost" onClick={() => setShowAllCredentials(true)} type="button">{t(`Show all ${credentials.length}`, `顯示全部 ${credentials.length} 個`, `显示全部 ${credentials.length} 个`, `${credentials.length} 件すべて表示`)}</button>
                  ) : null}
                  {egress.credentials.length === 0 ? <p className="px-note">{t("CPA's accounts appear here once CPA runs.", "CPA 運行之後，佢嘅帳號會喺度顯示。", "CPA 运行后，其账号会显示在这里。", "CPA が起動するとアカウントがここに表示されます。")}</p> : null}
                </div>
              </>
            ) : <p className="px-note">{t("Loading the accounts…", "載入緊帳號…", "正在载入账号…", "アカウントを読み込み中…")}</p>}
          </details>

          {browserTargets.length ? (
            <details className="px-sub">
              <summary>{t("Browser-tab accounts", "瀏覽器分頁帳號", "浏览器标签页账号", "ブラウザータブのアカウント")}<span>{browserTargets.length}</span></summary>
              <div className="px-route-list">
                {browserTargets.map((entry) => (
                  <div className="px-route" key={entry.target}>
                    <strong title={entry.target.slice(8)}>{entry.target.slice(8).replace(/^persist:/, "")}<small>{entry.policy.mode === "profile" ? t("its own proxy", "佢自己嘅代理", "其自己的代理", "専用プロキシ") : fromWords(entry)}</small></strong>
                    <span className="px-effective">{routeWords(entry.route)}<small>{statWords(entry)}</small></span>
                    <span className="px-hint">{t("Set on the GPT Browser page", "喺 GPT 瀏覽器頁設定", "在 GPT 浏览器页面设置", "GPT ブラウザーのページで設定")}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </details>
      ) : null}

      {snapshot ? (
        <section className="px-programs" aria-label={t("What follows these routes", "跟呢啲路由嘅程式", "跟随这些路由的程序", "これらの経路に従うもの")}>
          <h2>{t("What follows these routes", "跟呢啲路由嘅程式", "跟随这些路由的程序", "これらの経路に従うもの")}</h2>
          <div className={`px-prog${router?.running ? " is-up" : router ? " is-down" : ""}`}>
            <i />
            <span><strong>{t("Proxy router", "代理路由器", "代理路由器", "プロキシルーター")}</strong>{router ? (router.running ? t(`running on 127.0.0.1:${router.port}`, `運行緊 127.0.0.1:${router.port}`, `运行于 127.0.0.1:${router.port}`, `127.0.0.1:${router.port} で稼働中`) : t("stopped", "已停止", "已停止", "停止")) : "…"}</span>
            {router?.running ? <button className="px-ghost" disabled={busy} onClick={() => reconnect("")} title={t("Close open connections so they reconnect on the current routes", "關閉現有連線，等佢哋用而家嘅路由重新連線", "关闭现有连接，使其按当前路由重连", "現在の経路で再接続させます")} type="button"><Glyph d={LOOP} />{t("Reconnect all", "全部重新連線", "全部重新连接", "すべて再接続")}</button> : null}
          </div>
          <div className="px-prog is-up"><i /><span><strong>{t("App windows, updates and app plugins", "App 視窗、更新同 App 外掛", "App 窗口、更新和 App 插件", "ウィンドウ、更新、プラグイン")}</strong>{routeWords(appEntry?.route)}{statWords(appEntry) ? ` · ${statWords(appEntry)}` : ""}</span></div>
          <div className="px-prog is-up"><i /><span><strong>{t("Agents, their tools and MCP servers", "Agent、佢哋嘅工具同 MCP 伺服器", "Agent、其工具和 MCP 服务器", "エージェント、ツール、MCP サーバー")}</strong>{t("follow the App route live, no restart needed", "即時跟 App 路由，唔使重新開", "实时跟随 App 路由，无需重启", "再起動なしでアプリの経路に従う")}</span></div>
          {cpaInstalled ? (
            <div className={`px-prog${cpaOnRoute ? " is-up" : " is-slow"}`}>
              <i />
              <span><strong>CPA</strong>{cpaOnRoute
                ? t("model traffic follows its routes live", "模型連線即時跟佢嘅路由", "模型连接实时跟随其路由", "モデル通信は経路に即時に従います")
                : t("started before the proxy router: apply once so it follows the routes", "喺代理路由器之前開咗：套用一次就會跟路由", "在代理路由器之前启动：应用一次即可跟随路由", "ルーターより前に起動しました。一度適用してください")}</span>
              {cpaOnRoute ? null : (
                <button className="px-ghost" disabled={busy} onClick={() => void applyToCpa()} type="button">{t("Apply", "套用", "应用", "適用")}</button>
              )}
            </div>
          ) : null}
          <div className="px-prog is-up"><i /><span><strong>ChatGPT Desktop</strong>{t("its own router port on the App route", "用 App 路由，有自己嘅路由器連接埠", "使用 App 路由，有自己的路由器端口", "アプリの経路で専用ポート")}</span></div>
          <div className="px-prog is-off"><i /><span><strong>{t("Your own Chrome (Sign in with Chrome)", "你自己嘅 Chrome（用 Chrome 登入）", "你自己的 Chrome（用 Chrome 登录）", "ご自身の Chrome（Chrome でサインイン）")}</strong>{t("not routed: it uses Chrome's own proxy settings", "唔經路由：用 Chrome 自己嘅代理設定", "不经路由：使用 Chrome 自己的代理设置", "経路外：Chrome 自身の設定を使います")}</span></div>
        </section>
      ) : null}
    </section>
  );
}
