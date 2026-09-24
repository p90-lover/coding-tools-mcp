import { useEffect, useState } from "react";
import type { ExternalServiceSnapshot, Language } from "../types";
import "./commandcode-proxy.css";

interface CommandCodeProxySurfaceProps {
  language: Language;
  service: ExternalServiceSnapshot;
  busy: string | null;
  onCheck: () => void;
  onCopyPlan: () => void;
  onApplyNonSecret: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onOpenProviders: () => void;
}

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "http://127.0.0.1:9090";
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("Clipboard is unavailable");
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function CommandCodeProxySurface({
  language,
  service,
  busy,
  onCheck,
  onCopyPlan,
  onApplyNonSecret,
  onStart,
  onStop,
  onRestart,
  onOpenProviders,
}: CommandCodeProxySurfaceProps) {
  const origin = originOf(service.endpoint);
  const openaiBase = `${origin}/v1`;
  const anthropicBase = `${origin}/v1`;
  const health = service.health;
  const models = health?.models ?? [];
  const listening = (() => {
    try {
      const url = new URL(service.endpoint);
      return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    } catch {
      return "127.0.0.1:9090";
    }
  })();

  const copy = async (value: string) => {
    await copyText(value);
  };

  return (
    <section className="commandcode-proxy-surface" aria-label="CommandCode AI Proxy">
      <pre className="commandcode-banner">
{` CommandCode AI Proxy ${health?.version ? `v${health.version}` : "v1.0.0"}
 ===========================
 Listening on ${listening}
 Auth: ENABLED (API key required)

 Cursor settings:
 Base URL : ${openaiBase}
 API Key  : app-managed (not shown)

 Claude Code:
 ANTHROPIC_BASE_URL=${anthropicBase}
 ANTHROPIC_API_KEY=<proxy key>`}
      </pre>

      <p className="commandcode-scope">
        {text(
          language,
          "This panel is the pinned zahidhussaina2l/commandcode-proxy banner. The proxy stays out of process on loopback. Coding Tools can start, stop and inspect it; chat completions still come from clients pointed at these URLs.",
          "此面板對應 pinned zahidhussaina2l/commandcode-proxy 啟動 banner。Proxy 仍在 loopback 進程外。Coding Tools 可啟動、停止與檢查；實際對話仍由指向這些 URL 的客戶端發送。",
        )}
      </p>

      <dl className="commandcode-health">
        <div>
          <dt>{text(language, "Health", "健康狀態")}</dt>
          <dd>{health?.status ?? service.status}</dd>
        </div>
        <div>
          <dt>{text(language, "Models", "模型")}</dt>
          <dd>{service.modelCount ?? models.length ?? "—"}</dd>
        </div>
        <div>
          <dt>{text(language, "User", "使用者")}</dt>
          <dd>{health?.user?.email || health?.user?.id || "—"}</dd>
        </div>
        <div>
          <dt>{text(language, "Credits", "額度")}</dt>
          <dd>{health?.credits ?? "—"}</dd>
        </div>
      </dl>

      {models.length ? (
        <ul className="commandcode-models">
          {models.map((model) => <li key={model}>{model}</li>)}
        </ul>
      ) : null}

      {health?.endpoints ? (
        <ul className="commandcode-endpoints">
          {Object.entries(health.endpoints).map(([name, path]) => (
            <li key={name}><code>{name}</code> {path}</li>
          ))}
        </ul>
      ) : (
        <ul className="commandcode-endpoints">
          <li><code>openai_chat</code> /v1/chat/completions</li>
          <li><code>openai_models</code> /v1/models</li>
          <li><code>anthropic_messages</code> /v1/messages</li>
        </ul>
      )}

      <div className="commandcode-actions">
        <button disabled={busy !== null} onClick={() => void copy(openaiBase)} type="button">
          {text(language, "Copy OpenAI base URL", "複製 OpenAI Base URL")}
        </button>
        <button disabled={busy !== null} onClick={() => void copy(anthropicBase)} type="button">
          {text(language, "Copy Anthropic base URL", "複製 Anthropic Base URL")}
        </button>
        <button disabled={busy !== null} onClick={onCheck} type="button">
          {busy === "inspect" ? "…" : text(language, "Check status", "檢查狀態")}
        </button>
        <button disabled={busy !== null} onClick={onCopyPlan} type="button">
          {busy === "copy-plan" ? "…" : text(language, "Copy plan", "複製計劃")}
        </button>
        <button disabled={busy !== null} onClick={onApplyNonSecret} type="button">
          {busy === "apply-plan" ? "…" : text(language, "Apply non-secret", "套用非密鑰步驟")}
        </button>
        <button disabled={busy !== null || !service.enabled || service.status === "ready"} onClick={onStart} type="button">
          {busy === "start" ? "…" : text(language, "Start", "啟動")}
        </button>
        <button disabled={busy !== null || !service.owned} onClick={onRestart} type="button">
          {busy === "restart" ? "…" : text(language, "Restart", "重新啟動")}
        </button>
        <button disabled={busy !== null || !service.owned} onClick={onStop} type="button">
          {busy === "stop" ? "…" : text(language, "Stop", "停止")}
        </button>
        <button onClick={onOpenProviders} type="button">
          {text(language, "Open CommandCode accounts", "開啟 CommandCode 帳戶")}
        </button>
      </div>
    </section>
  );
}

export function CommandCodeHostSurface({
  language,
  setError,
  openProviders,
}: {
  language: Language;
  setError: (error: string | null) => void;
  openProviders: () => void;
}) {
  const api = window.codexWebLauncher;
  const [service, setService] = useState<ExternalServiceSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [planText, setPlanText] = useState("");

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const snapshot = await api.externalServicesSnapshot();
    const next = snapshot.services.find((entry) => entry.id === "commandcode-proxy") ?? null;
    setService(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void (async () => {
      try {
        const current = await refresh();
        if (cancelled || !current) return;
        try {
          await api.inspectExternalService("commandcode-proxy");
        } catch {
          if (current.status !== "ready") await api.startExternalService("commandcode-proxy");
        }
        if (!cancelled) await refresh();
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    const unsubscribe = api.onExternalServicesChanged?.((next) => {
      const current = next.services.find((entry) => entry.id === "commandcode-proxy") ?? null;
      if (!cancelled) setService(current);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, setError]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (!api || busy) return;
    setBusy(name);
    setError(null);
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="commandcode-host-surface" data-tool="commandcode-proxy" data-original-chrome="true">
      <header className="commandcode-hostbar">
        <strong>CommandCode Proxy</strong>
        <span className={`commandcode-host-status status-${service?.status || "offline"}`}>
          {service?.status === "ready"
            ? text(language, "Connected", "已連線")
            : service?.status === "starting"
              ? text(language, "Starting", "正在啟動")
              : service?.status === "error"
                ? text(language, "Error", "錯誤")
                : text(language, "Offline", "離線")}
        </span>
      </header>
      {notice ? <p className="commandcode-scope">{notice}</p> : null}
      {planText ? <pre className="commandcode-banner">{planText}</pre> : null}
      {service ? (
        <CommandCodeProxySurface
          busy={busy}
          language={language}
          onApplyNonSecret={() => void run("apply-plan", async () => {
            const result = await api!.applyCommandCodeProxyPlan({
              baseUrl: service.endpoint,
              routerCli: service.routerCli ?? "model-router",
              curateCli: service.curateCli ?? "curate-models",
            });
            setPlanText(result.planText || planText);
            setNotice(text(
              language,
              "Credential set was not executed. Paste the user_* key only in Codex Router’s hidden prompt.",
              "未執行 credential set。user_* 金鑰只能在 Codex Router 隱藏提示中輸入。",
            ));
          })}
          onCheck={() => void run("inspect", () => api!.inspectExternalService("commandcode-proxy"))}
          onCopyPlan={() => void run("copy-plan", async () => {
            const plan = await api!.commandCodeProxyPlan({
              baseUrl: service.endpoint,
              routerCli: service.routerCli ?? "model-router",
              curateCli: service.curateCli ?? "curate-models",
            });
            setPlanText(plan.text);
            await navigator.clipboard.writeText(plan.text);
            setNotice(text(language, "Registration plan copied.", "已複製註冊計劃。"));
          })}
          onOpenProviders={openProviders}
          onRestart={() => void run("restart", () => api!.restartExternalService("commandcode-proxy"))}
          onStart={() => void run("start", () => api!.startExternalService("commandcode-proxy"))}
          onStop={() => void run("stop", () => api!.stopExternalService("commandcode-proxy"))}
          service={service}
        />
      ) : (
        <div className="commandcode-proxy-surface">
          <strong>{text(language, "Loading CommandCode Proxy…", "正在載入 CommandCode 代理…")}</strong>
        </div>
      )}
    </section>
  );
}
