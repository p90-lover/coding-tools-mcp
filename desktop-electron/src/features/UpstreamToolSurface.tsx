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
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);

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
    void api.upstreamToolsSnapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const current = toolFrom(next, toolId);
      if (current) {
        setEndpoint(current.endpoint);
        setSelectedSection(current.sections[0] || "");
      }
    }).catch((cause) => setError(messageOf(cause)));
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
          <strong>{localize(language, "Loading managed integration…", "正在載入受管理整合…")}</strong>
        </div>
      </section>
    );
  }

  const ready = tool.status === "ready";
  const statusText = ready
    ? localize(language, "Connected", "已連線")
    : tool.status === "starting"
      ? localize(language, "Installing / starting", "正在安裝／啟動")
      : tool.status === "error"
        ? localize(language, "Error", "錯誤")
        : localize(language, "Offline", "離線");

  return (
    <section className="upstream-tool-surface" data-tool={toolId}>
      <header className="upstream-tool-heading">
        <div>
          <span className="upstream-tool-kicker">
            {localize(language, "MANAGED PINNED UPSTREAM", "受管理固定上游版本")}
          </span>
          <h1>{tool.name}</h1>
          <p>
            {localize(
              language,
              `Coding Tools manages the complete ${tool.name} runtime pinned to ${tool.commit.slice(0, 12)} under ${tool.license}.`,
              `Coding Tools 會管理完整 ${tool.name} runtime，固定於 ${tool.commit.slice(0, 12)}，授權為 ${tool.license}。`,
            )}
          </p>
        </div>
        <span className={`upstream-tool-status status-${tool.status}`}>{statusText}</span>
      </header>

      <div className="upstream-tool-toolbar">
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
            : localize(language, "Install / Start", "安裝／啟動")}
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
      {!tool.sourceAvailable && !ready ? (
        <p className="upstream-tool-hint">
          {localize(
            language,
            `Install / Start prepares the pinned ${tool.name} runtime automatically. Superseded or incomplete copies are preserved under Trash, and staging stays under aiTemp.`,
            `「安裝／啟動」會自動準備固定版本嘅 ${tool.name} runtime。舊版本或未完成副本會保留喺 Trash，暫存工作只會放喺 aiTemp。`,
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
                : localize(language, "Use Install / Start to prepare and connect the managed loopback service.", "使用「安裝／啟動」準備並連接受管理嘅 loopback 服務。")}
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
