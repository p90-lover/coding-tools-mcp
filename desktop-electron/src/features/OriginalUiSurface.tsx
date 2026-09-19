import { useEffect, useMemo, useRef, useState } from "react";
import type { JsonObject } from "../api/contracts";
import type { Language, OriginalUiId, OriginalUiSnapshot, OriginalUiCatalog } from "../types";
import { CpaOriginalPanel } from "./CpaOriginalPanel";
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

function emptyCopy(language: Language, toolId: OriginalUiId, ready: boolean): { title: string; body: string } {
  const name = toolId === "cpa"
    ? "CPA"
    : toolId === "codex-router"
      ? "Codex Router"
      : toolId === "paseo"
        ? "Paseo"
        : "Anneal";
  if (toolId === "cpa") {
    return {
      title: localize(language, "CPA in Coding Tools", "CPA（Coding Tools 內嵌）"),
      body: localize(
        language,
        "Original CPA chrome is hosted inside Coding Tools. Handlers run in-process (codingTools.apps); Start is optional for proxy traffic only.",
        "原始 CPA 畫面由 Coding Tools 內嵌。處理常式在行程內執行（codingTools.apps）；「啟動」僅供可選的代理流量。",
      ),
    };
  }
  return {
    title: localize(language, `${name} in Coding Tools`, `${name}（Coding Tools 內嵌）`),
    body: ready
      ? localize(
        language,
        `Original ${name} chrome is hosted inside Coding Tools. Handlers run in-process (codingTools.apps); no standalone window and no extra listen port.`,
        `原始 ${name} 畫面由 Coding Tools 內嵌。處理常式在行程內執行（codingTools.apps）；不開啟獨立視窗，也不新增監聽連接埠。`,
      )
      : localize(
        language,
        "Start the bundled runtime, then Coding Tools embeds this module’s visual.",
        "啟動內建執行環境後，Coding Tools 會內嵌此模組畫面。",
      ),
  };
}

export function OriginalUiSurface({ toolId, language, setError }: OriginalUiSurfaceProps) {
  const api = window.codexWebLauncher;
  const [snapshot, setSnapshot] = useState<OriginalUiCatalog | null>(null);
  const [selectedSection, setSelectedSection] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const [dependency, setDependency] = useState<"postgres" | null>(null);
  const autoOpened = useRef(false);
  const lastStatus = useRef("");
  const lastGeneration = useRef(0);
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);
  const inProcessPanel = toolId === "cpa";

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
    setNotice("");
    setLocalError("");
    setDependency(null);
    setSelectedSection("");
  }, [toolId]);

  const callModule = async (operation: string, args: JsonObject = {}) => {
    const apps = window.codingTools?.apps;
    if (apps?.invoke) {
      return apps.invoke({ handle: toolId, moduleId: toolId, operation, arguments: args });
    }
    if (!apps?.call) throw new Error("Coding Tools apps API is unavailable");
    return apps.call({ moduleId: toolId, operation, arguments: args });
  };

  const openSection = async (section = selectedSection) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const result = await api.openOriginalUi(toolId, section);
    setSelectedSection(result.section);
    if (!inProcessPanel) setFrameUrl(result.url);
    setSnapshot((current) => current
      ? {
          ...current,
          tools: current.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
        }
      : current);
    if (result.unavailable) {
      setDependency(result.dependency ?? null);
      setLocalError(result.error || result.tool.error || "");
      return result;
    }
    setDependency(null);
    setLocalError("");
    setNotice(localize(
      language,
      "Visual is hosted inside Coding Tools. Handlers are in-process; the standalone app window is not launched.",
      "畫面由 Coding Tools 內嵌。處理常式在行程內執行，不會開啟獨立應用程式視窗。",
    ));
    return result;
  };

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void (async () => {
      try {
        try {
          const apps = window.codingTools?.apps;
          if (apps?.invoke) {
            await apps.invoke({ handle: toolId, operation: "inspect" });
          } else if (apps?.call) {
            await apps.call({ moduleId: toolId, operation: "inspect" });
          } else {
            try { await api.inspectOriginalUi(toolId); } catch { /* attach even if inspect is down */ }
          }
        } catch {
          try { await api.inspectOriginalUi(toolId); } catch { /* attach even if inspect is down */ }
        }
        const next = await api.originalUiSnapshot();
        if (cancelled) return;
        setSnapshot(next);
        const current = toolFrom(next, toolId);
        const section = current?.sections[0] || "";
        if (current) setSelectedSection(section);
        if (inProcessPanel) {
          try {
            const opened = await openSection(section);
            if (!cancelled && opened) autoOpened.current = true;
          } catch (cause) {
            if (!cancelled) {
              autoOpened.current = true;
              setLocalError(messageOf(cause));
            }
          }
          return;
        }
        if (current?.status === "ready" || current?.status === "offline" || current?.status === "starting") {
          const opened = await openSection(section);
          if (!cancelled && opened) autoOpened.current = true;
        } else {
          autoOpened.current = true;
        }
      } catch (cause) {
        if (!cancelled) {
          if (inProcessPanel) autoOpened.current = true;
          setLocalError(messageOf(cause));
        }
      }
    })();
    const unsubscribe = api.onExternalServicesChanged?.(() => {
      void api.originalUiSnapshot().then((next) => {
        if (!cancelled) setSnapshot(next);
      }).catch((cause) => {
        if (!cancelled) setLocalError(messageOf(cause));
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, language, toolId]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setLocalError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setLocalError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!tool || busy || !api || inProcessPanel) return;
    const generation = tool.longRun?.reconnectGeneration ?? 0;
    const recovered = lastStatus.current !== "" && lastStatus.current !== "ready" && tool.status === "ready";
    const generationBumped = generation > lastGeneration.current;
    lastStatus.current = tool.status;
    lastGeneration.current = generation;
    if (!autoOpened.current) return;
    if (!frameUrl) return;
    if (recovered || generationBumped) {
      void openSection(selectedSection || tool.sections[0]).catch((cause) => setLocalError(messageOf(cause)));
    }
  }, [api, busy, frameUrl, inProcessPanel, selectedSection, tool, toolId]);

  if (!tool) {
    return (
      <section
        className="original-ui-surface"
        data-tool={toolId}
        data-original-chrome="true"
        data-transport="in-process"
        data-visual={inProcessPanel ? "in-process-panel" : undefined}
      >
        {inProcessPanel ? (
          <div className="original-ui-frame-shell">
            <CpaOriginalPanel language={language} section={selectedSection || "dashboard"} setError={setLocalError} />
          </div>
        ) : (
          <div className="original-ui-frame-empty">
            <strong>{localize(language, "Loading Coding Tools module…", "正在載入 Coding Tools 模組…")}</strong>
          </div>
        )}
      </section>
    );
  }

  const ready = tool.status === "ready";
  const panelReady = inProcessPanel || ready;
  const statusText = inProcessPanel
    ? localize(language, "In-process", "行程內")
    : ready
      ? localize(language, "Connected", "已連線")
      : tool.status === "starting"
        ? localize(language, "Starting", "正在啟動")
        : tool.status === "error"
          ? localize(language, "Error", "錯誤")
          : localize(language, "Offline", "離線");
  const copy = emptyCopy(language, toolId, panelReady);

  return (
    <section
      className="original-ui-surface"
      data-process-optional={inProcessPanel ? "true" : undefined}
      data-tool={toolId}
      data-original-chrome="true"
      data-transport="in-process"
      data-visual={inProcessPanel ? "in-process-panel" : "iframe"}
    >
      <header className="original-ui-hostbar">
        <strong>{tool.name}</strong>
        <span className={`original-ui-status ${inProcessPanel ? "status-ready" : `status-${tool.status}`}`}>{statusText}</span>
        <div className="original-ui-hostbar-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void run(panelReady || inProcessPanel ? "open" : "start", async () => {
            if (!inProcessPanel && !ready) await callModule("start");
            await openSection();
          })} type="button">
            {busy === "start" || busy === "open" ? "…" : inProcessPanel || ready
              ? localize(language, "Reload visual", "重新載入畫面")
              : localize(language, "Start module", "啟動模組")}
          </button>
          {inProcessPanel && !ready ? (
            <button disabled={busy !== null} onClick={() => void run("start-proxy", async () => {
              await callModule("start");
            })} type="button">
              {busy === "start-proxy" ? "…" : localize(language, "Start proxy (optional)", "啟動代理（可選）")}
            </button>
          ) : null}
          {toolId === "cpa" ? (
            <button disabled={busy !== null} onClick={() => void run("copy-key", async () => {
              if (!api) throw new Error("Launcher IPC is unavailable");
              const copied = await api.copyCpaManagementKey();
              setNotice(localize(
                language,
                `CPA management key copied (${copied.length} chars). Paste it into the embedded login form.`,
                `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到內嵌登入表單。`,
              ));
            })} type="button">
              {busy === "copy-key" ? "…" : localize(language, "Copy management key", "複製管理金鑰")}
            </button>
          ) : null}
          <button disabled={busy !== null || tool.pid === null} onClick={() => void run("restart", async () => {
            await callModule("restart");
            await openSection();
          })} type="button">
            {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
          </button>
          <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void run("stop", async () => {
            await callModule("stop");
            if (!inProcessPanel) {
              setFrameUrl("");
              autoOpened.current = false;
            }
          })} type="button">
            {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
          </button>
        </div>
      </header>

      {dependency === "postgres" ? (
        <p className="original-ui-note" data-dependency="postgres">
          {localize(
            language,
            "Anneal APIs need Postgres. Handlers return { unavailable: true, dependency: \"postgres\" }; Coding Tools remains usable.",
            "Anneal API 需要 Postgres。處理常式會回傳 { unavailable: true, dependency: \"postgres\" }；Coding Tools 本身仍可使用。",
          )}
        </p>
      ) : null}
      {localError || tool.error ? <p className="original-ui-error">{localError || tool.error}</p> : null}
      {notice ? <p className="original-ui-note">{notice}</p> : null}

      <div className="original-ui-frame-shell">
        {inProcessPanel ? (
          <CpaOriginalPanel
            language={language}
            onSectionChange={(next) => {
              setSelectedSection(next);
              void openSection(next).catch((cause) => setLocalError(messageOf(cause)));
            }}
            section={selectedSection || "dashboard"}
            setError={setLocalError}
          />
        ) : frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={withReconnect(frameUrl, tool.longRun?.reconnectGeneration ?? 0)}
            title={`${tool.name} hosted in Coding Tools`}
          />
        ) : (
          <div className="original-ui-frame-empty">
            <strong>{copy.title}</strong>
            <span>{copy.body}</span>
          </div>
        )}
      </div>
    </section>
  );
}
