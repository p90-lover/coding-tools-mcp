import { useEffect, useMemo, useRef, useState } from "react";
import type { Language, OriginalUiId, OriginalUiSnapshot, OriginalUiCatalog } from "../types";
import "./original-ui.css";

interface OriginalUiSurfaceProps {
  toolId: OriginalUiId;
  language: Language;
  setError: (error: string | null) => void;
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function withReconnect(url: string, generation: number): string {
  if (!url || generation < 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("lr", String(generation));
  return parsed.toString();
}

function toolFrom(snapshot: OriginalUiCatalog | null, toolId: OriginalUiId): OriginalUiSnapshot | null {
  return snapshot?.tools.find((candidate) => candidate.id === toolId) ?? null;
}

export function OriginalUiSurface({ toolId, language, setError }: OriginalUiSurfaceProps) {
  const api = window.codexWebLauncher;
  const [snapshot, setSnapshot] = useState<OriginalUiCatalog | null>(null);
  const [selectedSection, setSelectedSection] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [originalWindow, setOriginalWindow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const autoOpened = useRef(false);
  const lastStatus = useRef("");
  const lastGeneration = useRef(0);
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const next = await api.originalUiSnapshot();
    setSnapshot(next);
    const current = toolFrom(next, toolId);
    if (current) setSelectedSection((value) => value || current.sections[0] || "");
    return current;
  };

  useEffect(() => {
    autoOpened.current = false;
    lastStatus.current = "";
    lastGeneration.current = 0;
    setFrameUrl("");
    setOriginalWindow(false);
    setNotice("");
    setSelectedSection("");
  }, [toolId]);

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void api.originalUiSnapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const current = toolFrom(next, toolId);
      if (current) setSelectedSection(current.sections[0] || "");
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onExternalServicesChanged?.(() => {
      void api.originalUiSnapshot().then((next) => {
        if (!cancelled) setSnapshot(next);
      }).catch((cause) => setError(messageOf(cause)));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, setError, toolId]);

  const run = async (name: string, action: () => Promise<unknown>) => {
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

  const openSection = async (section = selectedSection) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const result = await api.openOriginalUi(toolId, section);
    setSelectedSection(result.section);
    setFrameUrl(result.url);
    setOriginalWindow(result.originalWindow);
    setSnapshot((current) => current
      ? {
          ...current,
          tools: current.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
        }
      : current);
    if (result.originalWindow) {
      setNotice(localize(
        language,
        "Original Codex Router Control Center is open with its own chrome, layout, and controls.",
        "已開啟原始 Codex Router Control Center，保留原本的視窗外觀、版面與控制項。",
      ));
    }
    return result;
  };

  useEffect(() => {
    if (!tool || busy || !api) return;
    const generation = tool.longRun?.reconnectGeneration ?? 0;
    const recovered = lastStatus.current !== "" && lastStatus.current !== "ready" && tool.status === "ready";
    const generationBumped = generation > lastGeneration.current;
    lastStatus.current = tool.status;
    lastGeneration.current = generation;
    if (toolId !== "cpa" || tool.status !== "ready") return;
    if (!autoOpened.current) {
      autoOpened.current = true;
      void openSection(tool.sections[0]).catch((cause) => setError(messageOf(cause)));
      return;
    }
    if (recovered || generationBumped) {
      void openSection(selectedSection || tool.sections[0]).catch((cause) => setError(messageOf(cause)));
    }
  }, [api, busy, selectedSection, setError, tool, toolId]);

  if (!tool) {
    return (
      <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
        <div className="original-ui-frame-empty">
          <strong>{localize(language, "Loading original interface…", "正在載入原始介面…")}</strong>
        </div>
      </section>
    );
  }

  const ready = tool.status === "ready";
  const needsInstall = tool.installState === "not-installed"
    || tool.installState === "repair-required"
    || tool.installState === "error";
  const statusText = ready
    ? localize(language, "Connected", "已連線")
    : tool.status === "starting"
      ? localize(language, "Starting", "正在啟動")
      : tool.status === "error"
        ? localize(language, "Error", "錯誤")
        : localize(language, "Offline", "離線");

  return (
    <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
      <header className="original-ui-hostbar">
        <strong>{tool.name}</strong>
        <span className={`original-ui-status status-${tool.status}`}>{statusText}</span>
        <div className="original-ui-hostbar-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void run(ready ? "open" : "start", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            if (!ready) await api.startOriginalUi(toolId);
            await openSection();
          })} type="button">
            {busy === "start" || busy === "open" ? "…" : ready
              ? localize(language, "Open original UI", "開啟原始介面")
              : needsInstall
                ? localize(language, "Install / start original runtime", "安裝／啟動原始執行環境")
                : localize(language, "Start original UI", "啟動原始介面")}
          </button>
          {toolId === "cpa" ? (
            <button disabled={busy !== null} onClick={() => void run("copy-key", async () => {
              if (!api) throw new Error("Launcher IPC is unavailable");
              const copied = await api.copyCpaManagementKey();
              setNotice(localize(
                language,
                `CPA management key copied (${copied.length} chars). Paste it into the original login form.`,
                `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到原始登入表單。`,
              ));
            })} type="button">
              {busy === "copy-key" ? "…" : localize(language, "Copy management key", "複製管理金鑰")}
            </button>
          ) : null}
          <button disabled={busy !== null || !ready} onClick={() => void run("external", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.openOriginalUiExternal(toolId, selectedSection);
          })} type="button">
            {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
          </button>
          <button disabled={busy !== null || tool.pid === null} onClick={() => void run("restart", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.restartOriginalUi(toolId);
            await openSection();
          })} type="button">
            {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
          </button>
          <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void run("stop", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.stopOriginalUi(toolId);
            setFrameUrl("");
            setOriginalWindow(false);
            autoOpened.current = false;
          })} type="button">
            {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
          </button>
        </div>
      </header>

      {tool.error ? <p className="original-ui-error">{tool.error}</p> : null}
      {notice ? <p className="original-ui-note">{notice}</p> : null}

      <div className="original-ui-frame-shell">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={withReconnect(frameUrl, tool.longRun?.reconnectGeneration ?? 0)}
            title={`${tool.name} original ${selectedSection}`}
          />
        ) : (
          <div className="original-ui-frame-empty">
            <strong>
              {originalWindow
                ? localize(language, "Original Control Center window is open", "原始 Control Center 視窗已開啟")
                : localize(language, "Original interface", "原始介面")}
            </strong>
            <span>
              {ready
                ? localize(
                  language,
                  toolId === "cpa"
                    ? "The original CLIProxyAPI management panel fills this page. Login, providers, auth files, OAuth, quota, config, logs, system, and plugins keep their original layout."
                    : "Open the original Codex Router Control Center window. Dashboard, usage, models, local, harness, context, and settings keep the original chrome.",
                  toolId === "cpa"
                    ? "原始 CLIProxyAPI 管理面板會填滿此頁。登入、供應商、授權檔、OAuth、配額、設定、日誌、系統與外掛會保持原本版面。"
                    : "開啟原始 Codex Router Control Center 視窗。儀表板、用量、模型、本機、工作臺、上下文與設定會保持原本外觀。",
                )
                : localize(language, "Install and start the managed runtime, then the original UI opens here.", "先安裝並啟動受管理執行環境，原始介面就會在此開啟。")}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
