import { useCallback, useEffect, useState } from "react";
import type {
  Language,
  ProviderNetworkSnapshot,
  ProxyGatewayProfileSummary,
  ProxyGatewayStatus,
  ProxyProfileRecord,
} from "../types";
import { localText, messageOf } from "./execution-surface-utils";
import "./orchestration-control.css";
import "./network-proxy.css";

const GATEWAY_PROFILE_ID = "builtin-gateway";
// ProxyBridge's listeners and the gateway's own default port; a profile pointing at them would loop.
const LOOP_PORTS = new Set([17891, 17892, 17893, 17894]);
const TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";
const POLL_MS = 2_000;

function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function loopsBack(profile: ProxyProfileRecord, gatewayPort: number): boolean {
  return profile.id === GATEWAY_PROFILE_ID
    || (isLoopbackHost(profile.endpoint.host)
      && (LOOP_PORTS.has(profile.endpoint.port) || profile.endpoint.port === gatewayPort));
}

function endpointText(profile: ProxyGatewayProfileSummary | null): string {
  return profile ? `${profile.protocol}://${profile.host}:${profile.port}` : "—";
}

function formatBytes(value: number | undefined): string {
  const bytes = value ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function ProxyGatewaySurface({
  active,
  language,
  openNetwork,
  setError,
}: {
  active: boolean;
  language: Language;
  openNetwork: () => void;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<ProxyGatewayStatus | null>(null);
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setStatus(await api.proxyGatewayStatus());
  }, []);

  useEffect(() => {
    const api = window.codexWebLauncher;
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.proxyGatewayStatus(), api.providerSnapshot()]).then(([nextStatus, nextSnapshot]) => {
      if (cancelled) return;
      setStatus(nextStatus);
      setSnapshot(nextSnapshot);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribeGateway = api.onProxyGatewayChanged((next) => {
      if (!cancelled) setStatus(next);
    });
    const unsubscribeNetwork = api.onProviderNetworkChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribeGateway();
      unsubscribeNetwork();
    };
  }, [setError]);

  // Connection counters move constantly; poll them only while this tab is on screen.
  useEffect(() => {
    if (!active) return;
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    if (status) setPortDraft(String(status.port));
  }, [status?.port]);

  const run = async (operation: () => Promise<ProxyGatewayStatus>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await operation());
      setNotice(success);
    } catch (cause) {
      setError(messageOf(cause));
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const api = window.codexWebLauncher;
  const gatewayPort = status?.port ?? 17894;
  const profiles = (snapshot?.proxyProfiles ?? []).filter((profile) => !profile.archivedAt && profile.id !== GATEWAY_PROFILE_ID);
  const running = status?.running === true;
  const useForApp = status?.useForApp === true;
  const stats = status?.stats ?? null;
  const lastTest = status?.lastTest ?? null;
  const listen = status ? `${status.listen.host}:${status.listen.port}` : "—";
  const globalRoute = status?.globalRoute;
  const globalText = !globalRoute
    ? "—"
    : !globalRoute.enabled
      ? localText(language, "Direct (no app-wide proxy)", "直接連線（無全應用程式代理）", "直接连接（无全应用程序代理）", "直接接続（アプリ全体のプロキシなし）")
      : `${globalRoute.profile?.name ?? globalRoute.profileId ?? "—"} · ${endpointText(globalRoute.profile)}`;

  const chooseUpstream = (profileId: string) => {
    if (!api) return;
    void run(
      () => api.configureProxyGateway({ upstreamProfileId: profileId || null }),
      localText(language, "Upstream saved.", "上游代理已儲存。", "上游代理已保存。", "上流プロキシを保存しました。"),
    );
  };

  const savePort = () => {
    if (!api) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError(localText(
        language,
        "Enter a gateway port between 1024 and 65535.",
        "請輸入 1024 至 65535 之間的閘道連接埠。",
        "请输入 1024 至 65535 之间的网关端口。",
        "1024〜65535 のゲートウェイポートを入力してください。",
      ));
      return;
    }
    void run(
      () => api.configureProxyGateway({ port }),
      localText(language, `Gateway port set to ${port}.`, `閘道連接埠已設為 ${port}。`, `网关端口已设为 ${port}。`, `ゲートウェイのポートを ${port} にしました。`),
    );
  };

  const setRunning = (next: boolean) => {
    if (!api) return;
    void run(
      () => api.setProxyGatewayRunning(next),
      next
        ? localText(language, "Gateway started.", "閘道已啟動。", "网关已启动。", "ゲートウェイを開始しました。")
        : localText(language, "Gateway stopped; the app is back on its previous route.", "閘道已停止，應用程式已回到先前的路由。", "网关已停止，应用程序已恢复先前的路由。", "ゲートウェイを停止し、アプリは以前の経路に戻りました。"),
    );
  };

  const setForApp = (next: boolean) => {
    if (!api) return;
    void run(
      () => api.setProxyGatewayForApp(next),
      next
        ? localText(language, "The app now routes through the gateway.", "應用程式現已經由閘道連線。", "应用程序现已通过网关连接。", "アプリはゲートウェイ経由で接続します。")
        : localText(language, "The previous app-wide route was restored.", "已還原先前的全應用程式路由。", "已恢复先前的全应用程序路由。", "以前のアプリ全体の経路に戻しました。"),
    );
  };

  const testRoute = () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    void api.testProxyGateway().then((next) => {
      setStatus(next);
      setNotice("");
    }).catch((cause) => setError(messageOf(cause))).finally(() => setBusy(false));
  };

  return (
    <section className="control-surface network-proxy-surface proxy-gateway-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">{localText(language, "NETWORK", "網路", "网络", "ネットワーク")}</span>
          <h1>{localText(language, "Proxy Gateway", "代理閘道", "代理网关", "プロキシゲートウェイ")}</h1>
          <p>{localText(
            language,
            "A local proxy inside Coding Tools that relays the app's traffic through one upstream proxy profile. It listens on loopback only.",
            "Coding Tools 內建的本機代理，經由一個上游代理設定檔轉送應用程式的流量，只在 loopback 上監聽。",
            "Coding Tools 内置的本地代理，通过一个上游代理配置转发应用程序的流量，只在 loopback 上监听。",
            "Coding Tools 内蔵のローカルプロキシです。アプリの通信を 1 つの上流プロキシ経由で中継し、ループバックでのみ待ち受けます。",
          )}</p>
        </div>
        <button className="secondary-button" onClick={openNetwork} type="button">
          {localText(language, "Edit proxy profiles", "編輯代理設定檔", "编辑代理配置", "プロキシ設定を編集")}
        </button>
      </header>

      <section className="proxy-route-overview" aria-labelledby="proxy-gateway-heading">
        <div className="proxy-route-header">
          <div>
            <span className="surface-kicker">{localText(language, "GATEWAY", "閘道", "网关", "ゲートウェイ")}</span>
            <h2 id="proxy-gateway-heading">{localText(language, "Status", "狀態", "状态", "状態")}</h2>
          </div>
          <span className={`proxy-route-badge${running ? " is-ready" : ""}`}>
            {!status
              ? localText(language, "Checking", "檢查中", "检查中", "確認中")
              : running
                ? localText(language, "Running", "執行中", "运行中", "実行中")
                : localText(language, "Stopped", "已停止", "已停止", "停止中")}
          </span>
        </div>
        <dl className="proxy-route-list proxy-gateway-stats">
          <div><dt>{localText(language, "Listen address", "監聽位址", "监听地址", "待ち受けアドレス")}</dt><dd>{listen}</dd></div>
          <div><dt>{localText(language, "Upstream", "上游代理", "上游代理", "上流プロキシ")}</dt><dd>{status?.upstream ? `${status.upstream.name} · ${endpointText(status.upstream)}` : "—"}</dd></div>
          <div><dt>{localText(language, "Active connections", "使用中連線", "活动连接", "アクティブな接続")}</dt><dd>{stats?.activeConnections ?? 0}</dd></div>
          <div><dt>{localText(language, "Total connections", "連線總數", "连接总数", "接続の合計")}</dt><dd>{stats ? `${stats.totalConnections} (${stats.tunnels} CONNECT · ${stats.httpRequests} HTTP · ${stats.failures} ${localText(language, "failed", "失敗", "失败", "失敗")})` : "0"}</dd></div>
          <div><dt>{localText(language, "Sent to the app", "傳送至應用程式", "发送到应用程序", "アプリへ送信")}</dt><dd>{formatBytes(stats?.bytesSent)}</dd></div>
          <div><dt>{localText(language, "Received from the app", "從應用程式接收", "从应用程序接收", "アプリから受信")}</dt><dd>{formatBytes(stats?.bytesReceived)}</dd></div>
          <div className="proxy-gateway-wide"><dt>{localText(language, "Last error", "最近錯誤", "最近错误", "直近のエラー")}</dt><dd>{status?.lastError ? `${status.lastError.message} (${new Date(status.lastError.at).toLocaleTimeString()})` : "—"}</dd></div>
        </dl>
        <div className="proxy-route-actions">
          {running ? (
            <button className="secondary-button" disabled={busy} onClick={() => setRunning(false)} type="button">
              {localText(language, "Stop", "停止", "停止", "停止")}
            </button>
          ) : (
            <button className="primary-button compact" disabled={busy || !status?.upstreamProfileId} onClick={() => setRunning(true)} type="button">
              {localText(language, "Start", "啟動", "启动", "開始")}
            </button>
          )}
          <button className="secondary-button" disabled={busy || !running} onClick={testRoute} type="button">
            {localText(language, "Test", "測試", "测试", "テスト")}
          </button>
          <small>{localText(
            language,
            `Test fetches ${TRACE_URL} through the gateway and shows the exit IP and location.`,
            `測試會經由閘道擷取 ${TRACE_URL}，並顯示出口 IP 與地區。`,
            `测试会通过网关获取 ${TRACE_URL}，并显示出口 IP 和地区。`,
            `テストはゲートウェイ経由で ${TRACE_URL} を取得し、出口 IP と地域を表示します。`,
          )}</small>
        </div>
        {lastTest ? (
          <p className={`proxy-gateway-test${lastTest.ok ? " is-ok" : " is-failed"}`} role="status">
            {lastTest.ok
              ? <><code>ip={lastTest.ip}</code> <code>loc={lastTest.loc ?? "?"}</code>{lastTest.latencyMs !== undefined ? ` · ${lastTest.latencyMs} ms` : ""}</>
              : localText(language, `Test failed: ${lastTest.error ?? "unknown"}`, `測試失敗：${lastTest.error ?? "未知"}`, `测试失败：${lastTest.error ?? "未知"}`, `テストに失敗しました：${lastTest.error ?? "不明"}`)}
          </p>
        ) : null}
      </section>

      <div className="control-grid two-column">
        <section className="control-panel">
          <h2>{localText(language, "Upstream proxy", "上游代理", "上游代理", "上流プロキシ")}</h2>
          <div className="control-fields">
            <label className="full-row">
              <span>{localText(language, "Proxy profile", "代理設定檔", "代理配置", "プロキシ設定")}</span>
              <select
                disabled={busy || !status}
                onChange={(event) => chooseUpstream(event.target.value)}
                value={status?.upstreamProfileId ?? ""}
              >
                <option value="">—</option>
                {profiles.map((profile) => {
                  const loop = loopsBack(profile, gatewayPort);
                  return (
                    <option disabled={loop || !profile.enabled} key={profile.id} value={profile.id}>
                      {profile.name} · {profile.endpoint.protocol}://{profile.endpoint.host}:{profile.endpoint.port}
                      {loop ? ` (${localText(language, "loops back", "會形成迴圈", "会形成回环", "ループします")})` : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              <span>{localText(language, "Gateway port", "閘道連接埠", "网关端口", "ゲートウェイのポート")}</span>
              <input disabled={busy} inputMode="numeric" onChange={(event) => setPortDraft(event.target.value)} value={portDraft} />
            </label>
          </div>
          <div className="control-actions">
            <button className="secondary-button" disabled={busy || !status || portDraft === String(status.port)} onClick={savePort} type="button">
              {localText(language, "Save port", "儲存連接埠", "保存端口", "ポートを保存")}
            </button>
          </div>
          <p className="proxy-secret-help">{localText(
            language,
            "HTTP, HTTPS and SOCKS5 upstreams are supported. Credentials stay in the encrypted proxy profile store; edit them in Network Proxy. Ports 17891-17893 belong to ProxyBridge and are refused.",
            "支援 HTTP、HTTPS 與 SOCKS5 上游代理。憑證保存在加密的代理設定檔儲存中，請在「網路代理」編輯。17891-17893 連接埠屬於 ProxyBridge，不可使用。",
            "支持 HTTP、HTTPS 和 SOCKS5 上游代理。凭据保存在加密的代理配置存储中，请在“网络代理”中编辑。17891-17893 端口属于 ProxyBridge，不可使用。",
            "HTTP・HTTPS・SOCKS5 の上流に対応します。認証情報は暗号化されたプロキシ設定に保存され、ネットワークプロキシで編集します。17891〜17893 は ProxyBridge 用のため使用できません。",
          )}</p>
        </section>

        <section className="control-panel">
          <h2>{localText(language, "Use for this app", "用於此應用程式", "用于此应用程序", "このアプリで使用")}</h2>
          <label className="check-row">
            <input
              checked={useForApp}
              disabled={busy || !status?.upstreamProfileId}
              onChange={(event) => setForApp(event.target.checked)}
              type="checkbox"
            />
            <span>{localText(
              language,
              "Route ChatGPT, the GPT Browser, the Codex bridge, CPA, Antigravity and ChatGPT Desktop through the gateway",
              "經由閘道連線 ChatGPT、GPT 瀏覽器、Codex 橋接、CPA、Antigravity 與 ChatGPT Desktop",
              "通过网关连接 ChatGPT、GPT 浏览器、Codex 桥接、CPA、Antigravity 和 ChatGPT Desktop",
              "ChatGPT、GPT ブラウザー、Codex ブリッジ、CPA、Antigravity、ChatGPT Desktop をゲートウェイ経由にする",
            )}</span>
          </label>
          <dl className="proxy-route-list">
            <div><dt>{localText(language, "Current app-wide route", "目前全應用程式路由", "当前全应用程序路由", "現在のアプリ全体の経路")}</dt><dd>{globalText}</dd></div>
            <div><dt>{localText(language, "Restored when switched off", "關閉時還原為", "关闭时恢复为", "オフにすると戻る経路")}</dt><dd>{useForApp && status?.previousGlobal
              ? (status.previousGlobal.enabled
                ? profiles.find((profile) => profile.id === status.previousGlobal?.profileId)?.name ?? status.previousGlobal.profileId ?? "—"
                : localText(language, "Direct", "直接連線", "直接连接", "直接接続"))
              : "—"}</dd></div>
          </dl>
          <p className="proxy-secret-help">{localText(
            language,
            "Once \"Use for this app\" is on, ProxyBridge on 127.0.0.1:17891 is no longer needed for the app's own traffic. Other programs that ProxyBridge routes are not affected. CPA and other services that were already running pick up the route when they restart (Network Proxy → Apply route to CPA).",
            "開啟「用於此應用程式」後，應用程式本身的流量不再需要 127.0.0.1:17891 上的 ProxyBridge。ProxyBridge 代理的其他程式不受影響。已在執行的 CPA 等服務會在重新啟動後套用新路由（網路代理 → 套用路由至 CPA）。",
            "开启“用于此应用程序”后，应用程序自身的流量不再需要 127.0.0.1:17891 上的 ProxyBridge。ProxyBridge 代理的其他程序不受影响。已在运行的 CPA 等服务会在重启后应用新路由（网络代理 → 应用路由到 CPA）。",
            "「このアプリで使用」をオンにすると、アプリ自身の通信に 127.0.0.1:17891 の ProxyBridge は不要になります。ProxyBridge が中継する他のプログラムには影響しません。実行中の CPA などのサービスは再起動時に新しい経路を使います（ネットワークプロキシ → CPA に経路を適用）。",
          )}</p>
        </section>
      </div>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}
