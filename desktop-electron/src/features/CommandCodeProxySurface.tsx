import type { ExternalServiceSnapshot, Language } from "../types";
import "./commandcode-proxy.css";

interface CommandCodeProxySurfaceProps {
  language: Language;
  service: ExternalServiceSnapshot;
  busy: string | null;
  onCheck: () => void;
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

export function CommandCodeProxySurface({
  language,
  service,
  busy,
  onCheck,
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
          <dd>{service.longRun?.uiStatus === "reconnecting"
            ? text(language, "Reconnecting", "正在重連")
            : service.longRun?.uiStatus === "blocked"
              ? text(language, "Reconnect paused", "重連已暫停")
              : health?.status ?? service.status}</dd>
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
          {busy === "inspect" ? "…" : text(language, "Check", "檢查")}
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
