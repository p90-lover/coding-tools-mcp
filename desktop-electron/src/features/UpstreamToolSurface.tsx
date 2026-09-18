import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Language,
  UpstreamToolActResult,
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
  const [agentId, setAgentId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [messageId, setMessageId] = useState("");
  const [createPrompt, setCreatePrompt] = useState("");
  const [createProvider, setCreateProvider] = useState("claude");
  const [inboxDecision, setInboxDecision] = useState("approve");
  const [actDetail, setActDetail] = useState("");
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

  const openExternal = () => run("external", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.openUpstreamToolExternal(toolId, selectedSection);
  });

  const act = async (name: string, input: Record<string, string>) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    setBusy(name);
    setError(null);
    try {
      const result: UpstreamToolActResult = await api.actUpstreamTool({
        toolId,
        ...input,
      });
      setActDetail(result.ok ? result.detail : result.detail || "request failed");
      if (!result.ok) setError(result.detail);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

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
  const annealManagedHint = toolId === "anneal"
    ? localize(
      language,
      "Coding Tools manages Anneal through WSL2 and Docker on Windows. Its original board is embedded from the managed loopback web service at 127.0.0.1:5173.",
      "Coding Tools 會喺 Windows 透過 WSL2 同 Docker 管理 Anneal，並由 127.0.0.1:5173 嘅受管 loopback 網頁服務內嵌原版看板。",
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
          <span>{localize(language, "Managed loopback endpoint", "受管 loopback 端點")}</span>
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
        <button className="primary" disabled={busy !== null || !ready} onClick={() => void openEmbedded()} type="button">
          {busy === "open" ? "…" : ready
            ? localize(language, "Open full UI", "開啟完整介面")
            : localize(language, "Waiting for managed service", "等待受管服務")}
        </button>
        <button disabled={busy !== null || !ready} onClick={() => void openExternal()} type="button">
          {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
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
      {annealManagedHint ? <p className="upstream-tool-hint">{annealManagedHint}</p> : null}
      {!ready ? (
        <p className="upstream-tool-hint">
          {localize(
            language,
            "Use the connection controls below to install, start, stop, or repair the managed service.",
            "請使用下方連線控制安裝、啟動、停止或修復受管服務。",
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
                ? localize(language, "Opening the original embedded interface.", "正在開啟原版內嵌介面。")
                : localize(language, "Coding Tools is preparing the managed loopback service.", "Coding Tools 正在準備受管 loopback 服務。")}
            </span>
          </div>
        )}
      </div>

      <section className="upstream-original-function" aria-label="Original function">
        <h2>{localize(language, "Original function", "原版功能")}</h2>
        {toolId === "paseo" ? (
          <div className="upstream-original-actions">
            <p>
              {localize(
                language,
                "Allowlisted protocol v1 RPCs: send, resume, cancel, archive, permission, create. These call the running Paseo daemon; they are not decorative.",
                "允許名單 protocol v1 RPC：send、resume、cancel、archive、permission、create。會打到已運行的 Paseo daemon，不是裝飾按鈕。",
              )}
            </p>
            <label>
              <span>agent / session id</span>
              <input onChange={(event) => setAgentId(event.target.value)} spellCheck={false} value={agentId} />
            </label>
            <label>
              <span>prompt</span>
              <input onChange={(event) => setCreatePrompt(event.target.value)} spellCheck={false} value={createPrompt} />
            </label>
            <label>
              <span>provider</span>
              <input onChange={(event) => setCreateProvider(event.target.value)} spellCheck={false} value={createProvider} />
            </label>
            <button disabled={busy !== null} onClick={() => void act("send", { op: "send", agentId, text: createPrompt || "ping" })} type="button">
              {localize(language, "Send", "傳送")}
            </button>
            <button disabled={busy !== null} onClick={() => void act("resume", { op: "resume", provider: createProvider, sessionId: agentId })} type="button">
              {localize(language, "Resume", "恢復")}
            </button>
            <button disabled={busy !== null} onClick={() => void act("cancel", { op: "cancel", agentId })} type="button">{localize(language, "Cancel", "取消")}</button>
            <button disabled={busy !== null} onClick={() => void act("archive", { op: "archive", agentId })} type="button">{localize(language, "Archive", "封存")}</button>
            <button disabled={busy !== null} onClick={() => void act("permission", { op: "permission", agentId, requestId: agentId, behavior: "allow" })} type="button">
              {localize(language, "Allow", "允許")}
            </button>
            <button disabled={busy !== null} onClick={() => void act("create", { op: "create", provider: createProvider, cwd: ".", text: createPrompt || "hello" })} type="button">
              {localize(language, "Create", "建立")}
            </button>
          </div>
        ) : (
          <div className="upstream-original-actions">
            <p>
              {localize(
                language,
                "Allowlisted POSTs: start/retry/archive/unarchive, chain hold|resume, inbox decision/reply/close. Runner and scheduler stay in Anneal.",
                "允許名單 POST：start／retry／archive／unarchive、chain hold｜resume、inbox decision／reply／close。Runner 與排程仍在 Anneal。",
              )}
            </p>
            <label>
              <span>task id</span>
              <input onChange={(event) => setTaskId(event.target.value)} spellCheck={false} value={taskId} />
            </label>
            <button disabled={busy !== null} onClick={() => void act("start", { op: "start", taskId })} type="button">{localize(language, "Start", "開始")}</button>
            <button disabled={busy !== null} onClick={() => void act("retry", { op: "retry", taskId })} type="button">{localize(language, "Retry", "重試")}</button>
            <button disabled={busy !== null} onClick={() => void act("hold", { op: "hold", taskId })} type="button">{localize(language, "Hold", "暫停")}</button>
            <button disabled={busy !== null} onClick={() => void act("resume", { op: "resume", taskId })} type="button">{localize(language, "Resume", "恢復")}</button>
            <button disabled={busy !== null} onClick={() => void act("archive", { op: "archive", taskId })} type="button">{localize(language, "Archive", "封存")}</button>
            <label>
              <span>inbox message id</span>
              <input onChange={(event) => setMessageId(event.target.value)} spellCheck={false} value={messageId} />
            </label>
            <label>
              <span>decision</span>
              <input onChange={(event) => setInboxDecision(event.target.value)} spellCheck={false} value={inboxDecision} />
            </label>
            <button disabled={busy !== null} onClick={() => void act("inbox", { op: "inbox_decision", messageId, text: inboxDecision })} type="button">
              {localize(language, "Inbox decision", "Inbox 決策")}
            </button>
          </div>
        )}
        {actDetail ? <p className="upstream-tool-hint">{actDetail}</p> : null}
      </section>

      {nativeControl ? (
        <details className="upstream-native-control" open={!ready}>
          <summary>{localize(language, "Coding Tools managed connection controls", "Coding Tools 受管連線控制")}</summary>
          <div>{nativeControl}</div>
        </details>
      ) : null}
    </section>
  );
}
