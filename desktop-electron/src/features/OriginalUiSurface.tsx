import { useEffect, useMemo, useState } from "react";
import type { Language, OriginalUiId, OriginalUiSnapshot, OriginalUiCatalog } from "../types";
import "./original-ui.css";

interface OriginalUiSurfaceProps {
  toolId: OriginalUiId;
  language: Language;
  setError: (error: string | null) => void;
}

interface CatalogOperation {
  name: string;
  readOnly?: boolean;
  description?: string;
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function operationsFromCatalog(catalog: { modules?: unknown }, toolId: OriginalUiId): CatalogOperation[] {
  if (!Array.isArray(catalog.modules)) return [];
  const entry = catalog.modules.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    return (candidate as { id?: unknown }).id === toolId;
  }) as { operations?: unknown } | undefined;
  if (!entry || !Array.isArray(entry.operations)) return [];
  return entry.operations.flatMap((operation) => {
    if (typeof operation === "string") return [{ name: operation }];
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return [];
    const item = operation as { name?: unknown; readOnly?: unknown; description?: unknown };
    if (typeof item.name !== "string") return [];
    return [{
      name: item.name,
      readOnly: item.readOnly === true,
      description: typeof item.description === "string" ? item.description : "",
    }];
  });
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
  return {
    title: localize(language, `${name} module APIs`, `${name} 模組 API`),
    body: ready
      ? localize(
        language,
        `Drive ${name} through Coding Tools APIs (codingTools.apps). The standalone app window is not launched.`,
        `透過 Coding Tools API（codingTools.apps）驅動 ${name}。不會開啟獨立應用程式視窗。`,
      )
      : localize(
        language,
        "Start the bundled runtime, then Coding Tools APIs can drive this module.",
        "啟動內建執行環境後，Coding Tools API 就能驅動此模組。",
      ),
  };
}

export function OriginalUiSurface({ toolId, language, setError }: OriginalUiSurfaceProps) {
  const api = window.codexWebLauncher;
  const [snapshot, setSnapshot] = useState<OriginalUiCatalog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const [dependency, setDependency] = useState<"postgres" | null>(null);
  const [operations, setOperations] = useState<CatalogOperation[]>([]);
  const [lastResult, setLastResult] = useState("");
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const next = await api.originalUiSnapshot();
    setSnapshot(next);
    return toolFrom(next, toolId);
  };

  useEffect(() => {
    setNotice("");
    setLocalError("");
    setDependency(null);
    setOperations([]);
    setLastResult("");
  }, [toolId]);

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void (async () => {
      try {
        const apps = window.codingTools?.apps;
        if (apps?.call) {
          const inspected = await apps.call({ moduleId: toolId, operation: "inspect" });
          if (!cancelled) setLastResult(JSON.stringify(inspected, null, 2));
        } else {
          try { await api.inspectOriginalUi(toolId); } catch { /* attach even if inspect is down */ }
        }
        if (apps?.catalog) {
          const catalog = await apps.catalog();
          if (!cancelled) setOperations(operationsFromCatalog(catalog, toolId));
        }
        const next = await api.originalUiSnapshot();
        if (cancelled) return;
        setSnapshot(next);
      } catch (cause) {
        if (!cancelled) setLocalError(messageOf(cause));
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

  const callModule = async (operation: string, args: Record<string, unknown> = {}) => {
    const apps = window.codingTools?.apps;
    if (!apps?.call) throw new Error("Coding Tools apps API is unavailable");
    const output = await apps.call({ moduleId: toolId, operation, arguments: args });
    setLastResult(JSON.stringify(output, null, 2));
    const result = output.result && typeof output.result === "object"
      ? output.result as Record<string, unknown>
      : null;
    if (result?.unavailable === true) {
      setDependency(result.dependency === "postgres" ? "postgres" : null);
      setLocalError(String(result.error || ""));
    } else {
      setDependency(null);
      setLocalError("");
    }
    setNotice(localize(
      language,
      "Coding Tools APIs are driving this module. The standalone app window is not launched.",
      "此模組由 Coding Tools API 驅動，不會開啟獨立應用程式視窗。",
    ));
    return output;
  };

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

  if (!tool) {
    return (
      <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
        <div className="original-ui-frame-empty">
          <strong>{localize(language, "Loading module APIs…", "正在載入模組 API…")}</strong>
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
  const copy = emptyCopy(language, toolId, ready);

  return (
    <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
      <header className="original-ui-hostbar">
        <strong>{tool.name}</strong>
        <span className={`original-ui-status status-${tool.status}`}>{statusText}</span>
        <div className="original-ui-hostbar-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void run(ready ? "inspect" : "start", async () => {
            if (!ready) await callModule("start");
            await callModule("inspect");
          })} type="button">
            {busy === "start" || busy === "inspect" ? "…" : ready
              ? localize(language, "Inspect via API", "以 API 檢查")
              : localize(language, "Start module", "啟動模組")}
          </button>
          {toolId === "cpa" ? (
            <button disabled={busy !== null} onClick={() => void run("copy-key", async () => {
              if (!api) throw new Error("Launcher IPC is unavailable");
              const copied = await api.copyCpaManagementKey();
              setNotice(localize(
                language,
                `CPA management key copied (${copied.length} chars). Use it with Coding Tools APIs, not a standalone login window.`,
                `已複製 CPA 管理金鑰（${copied.length} 字）。請配合 Coding Tools API 使用，不要開啟獨立登入視窗。`,
              ));
            })} type="button">
              {busy === "copy-key" ? "…" : localize(language, "Copy management key", "複製管理金鑰")}
            </button>
          ) : null}
          <button disabled={busy !== null || tool.pid === null} onClick={() => void run("restart", async () => {
            await callModule("restart");
          })} type="button">
            {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
          </button>
          <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void run("stop", async () => {
            await callModule("stop");
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
        <div className="original-ui-frame-empty">
          <strong>{copy.title}</strong>
          <span>{copy.body}</span>
          {operations.length > 0 ? (
            <span>
              {localize(language, "Operations: ", "操作：")}
              {operations.map((entry) => entry.name).join(", ")}
            </span>
          ) : null}
        </div>
        {lastResult ? <pre className="original-ui-result">{lastResult}</pre> : null}
      </div>
    </section>
  );
}
