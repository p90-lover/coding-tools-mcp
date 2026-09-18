import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Language,
  UpstreamToolId,
  UpstreamToolSnapshot,
  UpstreamToolsSnapshot,
} from "../types";
import "./upstream-tool.css";

interface UpstreamToolSurfaceProps {
  toolId: UpstreamToolId;
  language: Language;
  setError: (error: string | null) => void;
  nativeControl?: ReactNode;
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function toolFrom(snapshot: UpstreamToolsSnapshot | null, toolId: UpstreamToolId): UpstreamToolSnapshot | null {
  return snapshot?.tools.find((candidate) => candidate.id === toolId) ?? null;
}

const SECTION_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  tasks: ["Tasks", "任務"],
  projects: ["Projects", "專案"],
  agents: ["Agents", "代理"],
  sessions: ["Sessions", "工作階段"],
  inbox: ["Inbox", "收件匣"],
  automations: ["Automations", "自動化"],
  triggers: ["Triggers", "觸發器"],
  costs: ["Costs", "成本"],
  goals: ["Goals", "目標"],
  connections: ["Connections", "連線"],
  settings: ["Settings", "設定"],
  workspaces: ["Workspaces", "工作區"],
  providers: ["Providers", "供應商"],
  plugins: ["Plugins", "外掛"],
  voice: ["Voice", "語音"],
};

function sectionLabel(language: Language, section: string): string {
  const labels = SECTION_LABELS[section];
  if (labels) return localize(language, labels[0], labels[1]);
  return section.replaceAll("-", " ").replace(/(^|\s)\S/g, (value) => value.toUpperCase());
}

export function UpstreamToolSurface({
  toolId,
  language,
  setError,
  nativeControl,
}: UpstreamToolSurfaceProps) {
  const api = window.codexWebLauncher;
  const [snapshot, setSnapshot] = useState<UpstreamToolsSnapshot | null>(null);
  const [selectedSection, setSelectedSection] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [chromeOpen, setChromeOpen] = useState(false);
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);
  const windowsHost = /windows/iu.test(navigator.userAgent);

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const next = await api.upstreamToolsSnapshot();
    setSnapshot(next);
    const current = toolFrom(next, toolId);
    if (current) {
      setEndpoint(current.endpoint);
      setSelectedSection((value) => value || current.sections[0] || "");
    }
    return current;
  };

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void (async () => {
      try {
        await api.inspectUpstreamTool(toolId);
        const next = await api.upstreamToolsSnapshot();
        if (cancelled) return;
        setSnapshot(next);
        const current = toolFrom(next, toolId);
        if (!current) return;
        setEndpoint(current.endpoint);
        const section = current.sections[0] || "";
        setSelectedSection(section);
        if (current.status === "ready" && section) {
          const result = await api.openEmbeddedTool(toolId, section);
          if (cancelled) return;
          setFrameUrl(result.url);
          setSnapshot((value) => value
            ? {
                ...value,
                tools: value.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
              }
            : { version: 1, tools: [result.tool] });
        }
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [api, setError, toolId]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const openEmbeddedTool = async (section = selectedSection) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const result = await api.openEmbeddedTool(toolId, section);
    setFrameUrl(result.url);
    setSnapshot((current) => current
      ? {
          ...current,
          tools: current.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
        }
      : current);
  };

  const saveEndpoint = () => run("endpoint", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.setUpstreamToolEndpoint(toolId, endpoint);
  });

  const probe = () => run("probe", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.inspectUpstreamTool(toolId);
  });

  const openEmbedded = () => run("open", async () => {
    await openEmbeddedTool();
  });

  const start = () => run("start", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.startUpstreamTool(toolId);
    await openEmbeddedTool();
  });

  const restart = () => run("restart", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.restartUpstreamTool(toolId);
    await openEmbeddedTool();
  });

  const stop = () => run("stop", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.stopUpstreamTool(toolId);
    setFrameUrl("");
  });

  const openExternal = () => run("external", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.openUpstreamToolExternal(toolId, selectedSection);
  });

  if (!tool) {
    return (
      <section className="upstream-tool-surface">
        <div className="upstream-tool-empty">
          <strong>{localize(language, "Loading upstream integration…", "正在載入上游整合…")}</strong>
        </div>
      </section>
    );
  }

  const ready = tool.status === "ready";
  const statusText = ready
    ? localize(language, "Connected", "已連線")
    : tool.status === "starting"
      ? localize(language, "Starting", "正在啟動")
      : tool.status === "error"
        ? localize(language, "Error", "錯誤")
        : localize(language, "Offline", "離線");

  const immersive = Boolean(frameUrl);
  const annealWindowsHint = toolId === "anneal"
    ? localize(
      language,
      `${windowsHost ? "This host looks like Windows. " : ""}Anneal's upstream supports macOS/Linux, not native Windows. If the API runs elsewhere, use a user-managed secure local port forward to 127.0.0.1:3000. The board works as soon as that loopback service is reachable.`,
      `${windowsHost ? "目前主機看起來是 Windows。" : ""}Anneal 上游支援 macOS／Linux，不是原生 Windows。若 API 在其他機器，請自行建立安全的本機 port-forward 到 127.0.0.1:3000。服務可達後，原版看板即可使用。`,
    )
    : null;

  return (
    <section className={`upstream-tool-surface${immersive ? " is-immersive" : ""}${immersive && chromeOpen ? " chrome-open" : ""}`} data-tool={toolId}>
      <header className="upstream-tool-heading">
        <div>
          <span className="upstream-tool-kicker">
            {localize(language, "PINNED UPSTREAM", "固定上游版本")}
          </span>
          <h1>{tool.name}</h1>
          {immersive ? null : (
            <p>
              {localize(
                language,
                `Full ${tool.name} interface pinned to ${tool.commit.slice(0, 12)} under ${tool.license}.`,
                `完整 ${tool.name} 介面，固定於 ${tool.commit.slice(0, 12)}，授權為 ${tool.license}。`,
              )}
            </p>
          )}
        </div>
        <span className={`upstream-tool-status status-${tool.status}`}>{statusText}</span>
        {immersive ? (
          <button className="upstream-chrome-toggle" onClick={() => setChromeOpen((value) => !value)} type="button">
            {chromeOpen
              ? localize(language, "Hide connection controls", "隱藏連線控制")
              : localize(language, "Connection controls", "連線控制")}
          </button>
        ) : null}
      </header>

      <div className={`upstream-tool-toolbar${immersive && !chromeOpen ? " is-collapsed" : ""}`}>
        <label className="upstream-endpoint-field">
          <span>{localize(language, "Local endpoint", "本機端點")}</span>
          <input
            aria-label={`${tool.name} endpoint`}
            onChange={(event) => setEndpoint(event.target.value)}
            spellCheck={false}
            value={endpoint}
          />
        </label>
        <button disabled={busy !== null} onClick={() => void saveEndpoint()} type="button">
          {busy === "endpoint" ? "…" : localize(language, "Save endpoint", "儲存端點")}
        </button>
        <button disabled={busy !== null} onClick={() => void probe()} type="button">
          {busy === "probe" ? "…" : localize(language, "Check", "檢查")}
        </button>
        <button className="primary" disabled={busy !== null} onClick={() => void (ready ? openEmbedded() : start())} type="button">
          {busy === "start" || busy === "open" ? "…" : ready
            ? localize(language, "Open full UI", "開啟完整介面")
            : localize(language, "Start pinned source", "啟動固定版本")}
        </button>
        <button disabled={busy !== null || !ready} onClick={() => void openExternal()} type="button">
          {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
        </button>
        <button disabled={busy !== null || tool.pid === null} onClick={() => void restart()} type="button">
          {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
        </button>
        <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void stop()} type="button">
          {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
        </button>
      </div>

      <nav className="upstream-section-tabs" aria-label={`${tool.name} sections`}>
        {tool.sections.map((section) => (
          <button
            className={section === selectedSection ? "is-active" : ""}
            key={section}
            onClick={() => {
              setSelectedSection(section);
              if (frameUrl) void openEmbeddedTool(section).catch((cause) => setError(messageOf(cause)));
            }}
            type="button"
          >
            {sectionLabel(language, section)}
          </button>
        ))}
      </nav>

      {tool.error ? <p className="upstream-tool-error">{tool.error}</p> : null}
      {annealWindowsHint ? <p className="upstream-tool-hint">{annealWindowsHint}</p> : null}
      {!tool.sourceConfigured && !ready ? (
        <p className="upstream-tool-hint">
          {localize(
            language,
            `Run ${tool.name} at ${tool.endpoint}, or configure its pinned source directory before using Start.`,
            `請先喺 ${tool.endpoint} 執行 ${tool.name}，或者設定固定版本嘅原始碼目錄後再使用「啟動」。`,
          )}
        </p>
      ) : null}

      <div className="upstream-tool-frame-shell">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write; microphone"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={frameUrl}
            title={`${tool.name} ${selectedSection}`}
          />
        ) : (
          <div className="upstream-tool-frame-empty">
            <strong>{localize(language, "Full upstream interface", "完整上游介面")}</strong>
            <span>
              {ready
                ? localize(language, "Choose a section and open the embedded interface.", "選擇頁面並開啟內嵌介面。")
                : localize(language, "Connect to the local loopback service to continue.", "連接本機 loopback 服務後繼續。")}
            </span>
          </div>
        )}
      </div>

      {nativeControl ? (
        <details className="upstream-native-control">
          <summary>{localize(language, "Coding Tools native controls", "Coding Tools 原生控制")}</summary>
          <div>{nativeControl}</div>
        </details>
      ) : null}
    </section>
  );
}
