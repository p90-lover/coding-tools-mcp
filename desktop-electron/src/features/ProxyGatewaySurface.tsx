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
// ProxyBridge's listeners and the gateway's own default ports; a profile pointing at them would loop.
const LOOP_PORTS = new Set([17891, 17892, 17893, 17894, 17895]);
const TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";
const POLL_MS = 2_000;

function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function loopsBack(profile: ProxyProfileRecord, gatewayPorts: readonly number[]): boolean {
  return profile.id === GATEWAY_PROFILE_ID
    || (isLoopbackHost(profile.endpoint.host)
      && (LOOP_PORTS.has(profile.endpoint.port) || gatewayPorts.includes(profile.endpoint.port)));
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
  const [tokenlessDraft, setTokenlessDraft] = useState("");
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

  useEffect(() => {
    if (status) setTokenlessDraft(String(status.tokenlessPort));
  }, [status?.tokenlessPort]);

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
  const gatewayPorts = [status?.port ?? 17894, status?.tokenlessPort ?? 17895];
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
    const tokenlessPort = Number(tokenlessDraft);
    const valid = (value: number) => Number.isInteger(value) && value >= 1024 && value <= 65535;
    if (!valid(port) || !valid(tokenlessPort) || port === tokenlessPort) {
      setError(localText(
        language,
        "Enter two different gateway ports between 1024 and 65535.",
        "請輸入兩個介於 1024 至 65535 之間且不同的閘道連接埠。",
        "请输入两个介于 1024 至 65535 之间且不同的网关端口。",
        "1024〜65535 の異なるゲートウェイポートを 2 つ入力してください。",
      ));
      return;
    }
    void run(
      () => api.configureProxyGateway({ port, tokenlessPort }),
      localText(language, `Gateway ports set to ${port} and ${tokenlessPort}.`, `閘道連接埠已設為 ${port} 與 ${tokenlessPort}。`, `网关端口已设为 ${port} 和 ${tokenlessPort}。`, `ゲートウェイのポートを ${port} と ${tokenlessPort} にしました。`),
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

  const rotateKey = () => {
    if (!api) return;
    void run(
      () => api.rotateProxyGatewayKey(),
      localText(
        language,
        "New access key saved. Restart CPA (Network Proxy → Apply route to CPA); the Codex bridge picks it up on its next start.",
        "已儲存新存取金鑰。請重新啟動 CPA（網路代理 → 套用路由至 CPA）；Codex 橋接會在下次啟動時取用。",
        "已保存新访问密钥。请重启 CPA（网络代理 → 应用路由到 CPA）；Codex 桥接会在下次启动时取用。",
        "新しいアクセスキーを保存しました。CPA を再起動してください（ネットワークプロキシ → CPA に経路を適用）。Codex ブリッジは次回起動時に使います。",
      ),
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
                : status.helperState === "unverified"
                  ? localText(language, "Unverified helper holds the port", "未驗證的輔助程序佔用連接埠", "未验证的辅助进程占用端口", "未確認のヘルパーがポートを使用中")
                  : status.helperState === "restarting"
                    ? localText(language, "Restarting (backing off)", "重新啟動中（延後重試）", "重启中（退避重试）", "再起動待ち（間隔を空けて再試行）")
                    : localText(language, "Stopped", "已停止", "已停止", "停止中")}
          </span>
        </div>
        <dl className="proxy-route-list proxy-gateway-stats">
          <div><dt>{localText(language, "Listen address", "監聽位址", "监听地址", "待ち受けアドレス")}</dt><dd>{listen}</dd></div>
          <div><dt>{localText(language, "Token-free port (ChatGPT Desktop)", "免權杖連接埠（ChatGPT Desktop）", "免令牌端口（ChatGPT Desktop）", "トークン不要のポート（ChatGPT Desktop）")}</dt><dd>{status
            ? `${status.listen.host}:${status.tokenlessPort} · ${status.tokenlessOpen
              ? localText(language, "open while ChatGPT Desktop runs", "ChatGPT Desktop 執行中，已開啟", "ChatGPT Desktop 运行中，已开启", "ChatGPT Desktop 実行中のため開いています")
              : localText(language, "closed", "已關閉", "已关闭", "閉じています")}`
            : "—"}</dd></div>
          <div><dt>{localText(language, "Upstream", "上游代理", "上游代理", "上流プロキシ")}</dt><dd>{status?.upstream ? `${status.upstream.name} · ${endpointText(status.upstream)}` : "—"}</dd></div>
          <div><dt>{localText(language, "Helper process", "輔助程序", "辅助进程", "ヘルパープロセス")}</dt><dd>{status?.helper
            ? `PID ${status.helper.pid} · ${status.helper.runtime}${status.helper.adopted ? ` · ${localText(language, "kept from the last session", "沿用上次工作階段", "沿用上次会话", "前回のセッションから継続")}` : ""}`
            : status?.unverifiedHelper
              ? `PID ${status.unverifiedHelper.pid} · ${localText(language, "unverified, retrying", "未驗證，重試中", "未验证，重试中", "未確認・再試行中")}`
              : status?.watchdog.nextRestartAt
                ? `${localText(language, "next restart", "下次重新啟動", "下次重启", "次の再起動")} ${new Date(status.watchdog.nextRestartAt).toLocaleTimeString()}`
                : "—"}</dd></div>
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
        {status?.needsRestart.length ? (
          <p className="proxy-gateway-test is-failed" role="status">{localText(
            language,
            "The access key was changed because something else held the gateway port. The Codex bridge and MCP still use the old key. Restart them when idle (they pick it up on their next start).",
            "由於有其他程式佔用閘道連接埠，存取金鑰已更換。Codex 橋接與 MCP 仍使用舊金鑰，請在閒置時重新啟動（它們會在下次啟動時取用新金鑰）。",
            "由于有其他程序占用网关端口，访问密钥已更换。Codex 桥接和 MCP 仍使用旧密钥，请在空闲时重启（它们会在下次启动时取用新密钥）。",
            "別のプログラムがゲートウェイのポートを使っていたため、アクセスキーを変更しました。Codex ブリッジと MCP はまだ古いキーを使っています。手が空いたときに再起動してください（次回起動時に新しいキーを使います）。",
          )}</p>
        ) : null}
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
                  const loop = loopsBack(profile, gatewayPorts);
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
            <label>
              <span>{localText(language, "Token-free port", "免權杖連接埠", "免令牌端口", "トークン不要のポート")}</span>
              <input disabled={busy} inputMode="numeric" onChange={(event) => setTokenlessDraft(event.target.value)} value={tokenlessDraft} />
            </label>
          </div>
          <div className="control-actions">
            <button
              className="secondary-button"
              disabled={busy || !status || (portDraft === String(status.port) && tokenlessDraft === String(status.tokenlessPort))}
              onClick={savePort}
              type="button"
            >
              {localText(language, "Save ports", "儲存連接埠", "保存端口", "ポートを保存")}
            </button>
          </div>
          <p className="proxy-secret-help">{localText(
            language,
            "HTTP, HTTPS and SOCKS5 upstreams are supported. Credentials stay in the encrypted proxy profile store; edit them in Network Proxy. Ports 17891-17893 belong to ProxyBridge and are refused.",
            "支援 HTTP、HTTPS 與 SOCKS5 上游代理。憑證保存在加密的代理設定檔儲存中，請在「網路代理」編輯。17891-17893 連接埠屬於 ProxyBridge，不可使用。",
            "支持 HTTP、HTTPS 和 SOCKS5 上游代理。凭据保存在加密的代理配置存储中，请在“网络代理”中编辑。17891-17893 端口属于 ProxyBridge，不可使用。",
            "HTTP・HTTPS・SOCKS5 の上流に対応します。認証情報は暗号化されたプロキシ設定に保存され、ネットワークプロキシで編集します。17891〜17893 は ProxyBridge 用のため使用できません。",
          )}</p>
          <p className="proxy-secret-help">{localText(
            language,
            "The gateway runs as a helper process that keeps running when Coding Tools restarts or updates, so the Codex bridge and CPA keep their network. The gateway port needs a local token that the app supplies; the token-free port opens only while ChatGPT Desktop runs, and while open any local program can use it.",
            "閘道以輔助程序執行，Coding Tools 重新啟動或更新時仍會繼續執行，讓 Codex 橋接與 CPA 保持連線。閘道連接埠需要由應用程式提供的本機權杖；免權杖連接埠只在 ChatGPT Desktop 執行時開啟，開啟期間本機任何程式都可使用它。",
            "网关以辅助进程运行，Coding Tools 重启或更新时仍会继续运行，让 Codex 桥接和 CPA 保持联网。网关端口需要由应用程序提供的本地令牌；免令牌端口只在 ChatGPT Desktop 运行时开启，开启期间本机任何程序都可以使用它。",
            "ゲートウェイはヘルパープロセスとして動作し、Coding Tools の再起動や更新中も動き続けるため、Codex ブリッジと CPA の通信は途切れません。ゲートウェイのポートにはアプリが渡すローカルトークンが必要です。トークン不要のポートは ChatGPT Desktop の実行中だけ開き、その間はこのマシンのどのプログラムからも使えます。",
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
          <div className="control-actions">
            <button className="secondary-button" disabled={busy || !status} onClick={rotateKey} type="button">
              {localText(language, "New access key", "新存取金鑰", "新访问密钥", "新しいアクセスキー")}
            </button>
          </div>
          <p className="proxy-secret-help">{localText(
            language,
            "The access key stays the same when the gateway restarts. A new key locks out anything holding the old one: running background services must restart to pick it up (Network Proxy → Apply route to CPA; the Codex bridge picks it up on its next start).",
            "閘道重新啟動時存取金鑰保持不變。新金鑰會擋下仍使用舊金鑰的程式：執行中的背景服務必須重新啟動才會取用（網路代理 → 套用路由至 CPA；Codex 橋接會在下次啟動時取用）。",
            "网关重启时访问密钥保持不变。新密钥会拦下仍使用旧密钥的程序：运行中的后台服务必须重启才会取用（网络代理 → 应用路由到 CPA；Codex 桥接会在下次启动时取用）。",
            "アクセスキーはゲートウェイを再起動しても変わりません。新しいキーにすると古いキーを持つものは接続できなくなります。実行中のバックグラウンドサービスは再起動で新しいキーを使います（ネットワークプロキシ → CPA に経路を適用。Codex ブリッジは次回起動時）。",
          )}</p>
        </section>
      </div>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}
