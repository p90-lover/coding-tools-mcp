import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Language,
  UpstreamToolActInput,
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
  const [unavailable, setUnavailable] = useState(false);
  const [dependency, setDependency] = useState<"postgres" | null>(null);
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
        try {
          const apps = window.codingTools?.apps;
          if (apps?.call) {
            await apps.call({ moduleId: toolId, operation: "inspect" });
          } else {
            try { await api.inspectUpstreamTool(toolId); } catch { /* attach even if inspect is down */ }
          }
        } catch { /* module inspect is best-effort on screen visit */ }
        const next = await api.upstreamToolsSnapshot();
        if (cancelled) return;
        setSnapshot(next);
        const current = toolFrom(next, toolId);
        if (!current) return;
        setEndpoint(current.endpoint);
        const section = current.sections[0] || "";
        setSelectedSection(section);
        setUnavailable(false);
        setDependency(null);
        try {
          const opened = await api.openEmbeddedTool(toolId, section);
          if (cancelled) return;
          setFrameUrl(opened.url);
          setUnavailable(opened.unavailable === true);
          setDependency(opened.dependency ?? null);
        } catch {
          setFrameUrl("");
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
      const current = await refresh();
      if (name === "inspect" && current?.status === "ready" && !frameUrl && api) {
        const opened = await api.openEmbeddedTool(toolId, selectedSection || current.sections[0] || "");
        setFrameUrl(opened.url);
        setUnavailable(opened.unavailable === true);
        setDependency(opened.dependency ?? null);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveEndpoint = () => run("endpoint", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.setUpstreamToolEndpoint(toolId, endpoint);
  });

  const probe = () => run("probe", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const apps = window.codingTools?.apps;
    if (apps?.call) {
      await apps.call({ moduleId: toolId, operation: "inspect" });
      return;
    }
    await api.inspectUpstreamTool(toolId);
  });

  const moduleOperation = (op: string): string => {
    if (toolId === "anneal") {
      if (op === "start") return "startTask";
      if (op === "inbox_decision") return "inboxDecision";
    }
    return op;
  };

  const act = async (name: string, input: Omit<UpstreamToolActInput, "toolId">) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    setBusy(name);
    setError(null);
    try {
      const apps = window.codingTools?.apps;
      if (apps?.call) {
        const output = await apps.call({
          moduleId: toolId,
          operation: moduleOperation(input.op),
          arguments: { ...input },
        });
        const detail = JSON.stringify(output.result ?? output);
        setActDetail(detail);
        if (output.ok === false) setError(detail);
        const result = output.result && typeof output.result === "object"
          ? output.result as Record<string, unknown>
          : null;
        if (result?.unavailable === true) {
          setUnavailable(true);
          setDependency(result.dependency === "postgres" ? "postgres" : null);
        }
        return;
      }
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

  const immersive = Boolean(frameUrl) || Boolean(nativeControl);
  const annealManagedHint = toolId === "anneal"
    ? localize(
      language,
      "Coding Tools manages Anneal through WSL2 and Docker on Windows. Drive it with codingTools.apps; Postgres outages return { unavailable: true } without freezing the shell.",
      "Coding Tools 會喺 Windows 透過 WSL2 同 Docker 管理 Anneal。請用 codingTools.apps 驅動；Postgres 中斷會回傳 { unavailable: true }，不會凍結主介面。",
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
                `${tool.name} is a Coding Tools module pinned to ${tool.commit.slice(0, 12)} under ${tool.license}. Call it through codingTools.apps.`,
                `${tool.name} 是 Coding Tools 模組，固定於 ${tool.commit.slice(0, 12)}，授權為 ${tool.license}。請透過 codingTools.apps 呼叫。`,
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
        <button className="primary" disabled={busy !== null} onClick={() => void run("inspect", async () => {
          const apps = window.codingTools?.apps;
          if (apps?.call) {
            await apps.call({ moduleId: toolId, operation: ready ? "inspect" : "start" });
            return;
          }
          await api?.inspectUpstreamTool(toolId);
        })} type="button">
          {busy === "inspect" ? "…" : ready
            ? localize(language, "Inspect via API", "以 API 檢查")
            : localize(language, "Start module", "啟動模組")}
        </button>
      </div>

      <nav className="upstream-section-tabs" aria-label={`${tool.name} sections`}>
        {tool.sections.map((section) => (
          <button
            className={section === selectedSection ? "is-active" : ""}
            key={section}
            onClick={() => {
              setSelectedSection(section);
              if (api) {
                void api.openEmbeddedTool(toolId, section).then((opened) => {
                  setFrameUrl(opened.url);
                  setUnavailable(opened.unavailable === true);
                  setDependency(opened.dependency ?? null);
                }).catch((cause) => setError(messageOf(cause)));
              }
            }}
            type="button"
          >
            {sectionLabel(language, section)}
          </button>
        ))}
      </nav>

      {tool.error ? <p className="upstream-tool-error">{tool.error}</p> : null}
      {annealManagedHint ? <p className="upstream-tool-hint">{annealManagedHint}</p> : null}
      {unavailable && (dependency === "postgres" || toolId === "anneal") ? (
        <p className="upstream-tool-hint" data-dependency="postgres">
          {localize(
            language,
            "Anneal APIs need Postgres. Handlers return { unavailable: true, dependency: \"postgres\" }. Coding Tools remains usable.",
            "Anneal API 需要 Postgres。處理常式會回傳 { unavailable: true, dependency: \"postgres\" }。Coding Tools 本身仍可使用。",
          )}
        </p>
      ) : null}
      {!ready ? (
        <p className="upstream-tool-hint">
          {localize(
            language,
            "Waiting for managed service. Use Coding Tools APIs or the connection controls below to start or inspect the bundled in-app service. Coding Tools does not download Paseo or Anneal at runtime.",
            "請使用下方連線控制啟動或檢查已內建服務。Coding Tools 不會在執行時下載 Paseo 或 Anneal。",
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
            title={`${tool.name} hosted in Coding Tools`}
          />
        ) : (
          <div className="upstream-tool-frame-empty">
            <strong>{localize(language, "Coding Tools hosted visual", "Coding Tools 內嵌畫面")}</strong>
            <span>
              {ready
                ? localize(language, "Original chrome is hosted inside Coding Tools. Handlers stay in-process; no standalone window.", "原始畫面由 Coding Tools 內嵌。處理常式留在行程內，不開啟獨立視窗。")
                : localize(language, "Coding Tools is preparing the managed visual.", "Coding Tools 正在準備受管畫面。")}
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
        <details className="upstream-native-control" open>
          <summary>{localize(language, "Coding Tools managed connection controls", "Coding Tools 受管連線控制")}</summary>
          <div>{nativeControl}</div>
        </details>
      ) : null}
    </section>
  );
}
