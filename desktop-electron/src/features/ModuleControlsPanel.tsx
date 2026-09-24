import { useEffect, useMemo, useState } from "react";
import type { JsonObject } from "../api/contracts";
import type {
  AppsLaunchModuleSnapshot,
  AppsLaunchSnapshot,
  ExternalServiceId,
  Language,
} from "../types";
import "./module-controls.css";

interface ModuleControlsPanelProps {
  moduleId: ExternalServiceId;
  language: Language;
  setError: (error: string | null) => void;
}

interface CatalogOperation {
  name: string;
  readOnly: boolean;
  description: string;
}

interface CatalogModule {
  id: string;
  name: string;
  kind?: string;
  transport?: string;
  operations: CatalogOperation[];
  launch?: { order?: number; dependsOn?: string[]; readyTimeoutMs?: number; startupPolicy?: string } | null;
  visual?: { embed?: string; endpoint?: string; controls?: string[] } | null;
}

const LIFECYCLE = ["install", "repair", "start", "restart", "stop"] as const;

function text(language: Language, english: string, chinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? chinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function catalogModule(payload: unknown, moduleId: string): CatalogModule | null {
  const modules = Array.isArray(asRecord(payload).modules) ? asRecord(payload).modules as unknown[] : [];
  for (const entry of modules) {
    const record = asRecord(entry);
    if (record.id !== moduleId) continue;
    const operations = Array.isArray(record.operations) ? record.operations : [];
    return {
      id: moduleId,
      name: typeof record.name === "string" ? record.name : moduleId,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      transport: typeof record.transport === "string" ? record.transport : undefined,
      launch: asRecord(record.launch) as CatalogModule["launch"],
      visual: asRecord(record.visual) as CatalogModule["visual"],
      operations: operations.flatMap((operation) => {
        if (typeof operation === "string") return [{ name: operation, readOnly: false, description: "" }];
        const spec = asRecord(operation);
        return typeof spec.name === "string"
          ? [{
              name: spec.name,
              readOnly: spec.readOnly === true,
              description: typeof spec.description === "string" ? spec.description : "",
            }]
          : [];
      }),
    };
  }
  return null;
}

function launchStatusLabel(language: Language, module: AppsLaunchModuleSnapshot | null, overall: AppsLaunchSnapshot | null): string {
  if (!module) return text(language, "Not scheduled", "未排程");
  if (overall?.status === "waiting" && module.planned) {
    return text(language, "Waiting for Coding Tools core", "等待 Coding Tools 核心啟動");
  }
  switch (module.status) {
    case "ready": return text(language, "Launched", "已啟動");
    case "launching": return text(language, "Launching", "正在啟動");
    case "waiting": return text(language, "Queued", "排隊中");
    case "blocked": return text(language, "Blocked", "已阻擋");
    case "error": return text(language, "Failed", "失敗");
    case "skipped": return text(language, "Skipped", "已略過");
    default: return text(language, "Pending", "等待中");
  }
}

function skipReasonLabel(language: Language, reason: string | null): string {
  switch (reason) {
    case "auto-start-disabled": return text(language, "Auto-launch is off for this module.", "此模組已關閉自動啟動。");
    case "manual-policy": return text(language, "Manifest marks this module as manual start.", "清單將此模組標記為手動啟動。");
    case "module-disabled": return text(language, "Module is disabled in Coding Tools.", "此模組已在 Coding Tools 停用。");
    case "service-disabled": return text(language, "The managed service is disabled.", "受管服務已停用。");
    case "not-installed": return text(language, "Only launches once installed.", "安裝後才會自動啟動。");
    case "no-bundled-runtime": return text(language, "No bundled runtime is shipped for this platform.", "此平台未內建執行環境。");
    case "install-on-startup-disabled": return text(language, "Install on startup is off; install once from here.", "已關閉啟動時安裝；請在此手動安裝一次。");
    case "install-in-progress": return text(language, "An install is already running.", "安裝正在進行中。");
    default: return reason ? reason : "";
  }
}

export function ModuleControlsPanel({ moduleId, language, setError }: ModuleControlsPanelProps) {
  const api = window.codexWebLauncher;
  const [launch, setLaunch] = useState<AppsLaunchSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogModule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [localError, setLocalError] = useState("");
  const module = useMemo(
    () => launch?.modules.find((entry) => entry.id === moduleId) ?? null,
    [launch, moduleId],
  );

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void api.appsLaunchSnapshot().then((next) => {
      if (!cancelled) setLaunch(next);
    }).catch((cause) => {
      if (!cancelled) setLocalError(messageOf(cause));
    });
    const apps = window.codingTools?.apps;
    if (apps?.catalog) {
      void apps.catalog().then((payload) => {
        if (!cancelled) setCatalog(catalogModule(payload, moduleId));
      }).catch(() => {
        if (!cancelled) setCatalog(null);
      });
    }
    const unsubscribe = api.onAppsLaunchChanged?.((next) => {
      if (!cancelled) setLaunch(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, moduleId]);

  const run = async (name: string, action: () => Promise<unknown>, { keepResult = false } = {}) => {
    if (!api) return;
    setBusy(name);
    setError(null);
    setLocalError("");
    if (!keepResult) setResult("");
    try {
      const value = await action();
      if (keepResult && value !== undefined) setResult(JSON.stringify(value, null, 2));
    } catch (cause) {
      setLocalError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const invoke = async (operation: string, args: JsonObject = {}) => {
    const apps = window.codingTools?.apps;
    if (apps?.invoke) return apps.invoke({ handle: moduleId, moduleId, operation, arguments: args });
    if (apps?.call) return apps.call({ moduleId, operation, arguments: args });
    throw new Error("Coding Tools apps API is unavailable");
  };

  const operations = catalog?.operations ?? [];
  const lifecycle = LIFECYCLE.filter((name) => operations.some((operation) => operation.name === name));
  const apiOperations = operations.filter((operation) => !LIFECYCLE.includes(operation.name as typeof LIFECYCLE[number]));
  const statusTone = module?.status === "ready"
    ? "ready"
    : module?.status === "error" || module?.status === "blocked"
      ? "error"
      : module?.status === "launching" || (launch?.status === "waiting" && module?.planned)
        ? "busy"
        : "idle";

  return (
    <section className="module-controls" data-module={moduleId} aria-label={`${catalog?.name ?? moduleId} controls`}>
      <header className="module-controls-header">
        <div>
          <span className="module-controls-eyebrow">{text(language, "CODING TOOLS CONTROLS", "CODING TOOLS 控制")}</span>
          <h2>{catalog?.name ?? module?.name ?? moduleId}</h2>
          <p>
            {text(
              language,
              "This module is launched by Coding Tools after its own core is ready and driven through the in-process handler. No separate server window or manual port setup.",
              "此模組由 Coding Tools 在核心就緒後自動啟動，並透過行程內處理常式驅動。不需要獨立伺服器視窗或手動設定連接埠。",
            )}
          </p>
        </div>
        <span className={`module-controls-status is-${statusTone}`}>{launchStatusLabel(language, module, launch)}</span>
      </header>

      {localError ? <p className="module-controls-error" role="alert">{localError}</p> : null}

      <div className="module-controls-grid">
        <article className="module-controls-card">
          <h3>{text(language, "Auto-launch", "自動啟動")}</h3>
          <dl>
            <div>
              <dt>{text(language, "Startup order", "啟動順序")}</dt>
              <dd>{module ? `#${(launch?.order.indexOf(module.id) ?? -1) + 1 || module.order}` : "—"}</dd>
            </div>
            <div>
              <dt>{text(language, "Depends on", "依賴")}</dt>
              <dd>{module?.dependsOn.length ? module.dependsOn.join(", ") : text(language, "Coding Tools core only", "僅 Coding Tools 核心")}</dd>
            </div>
            <div>
              <dt>{text(language, "Install state", "安裝狀態")}</dt>
              <dd>{module?.installState ?? "—"}{module?.bundledRuntime ? ` · ${text(language, "bundled", "內建")}` : ""}</dd>
            </div>
            <div>
              <dt>{text(language, "Last launch", "上次啟動")}</dt>
              <dd>
                {module?.lastLaunch?.at
                  ? `${new Date(module.lastLaunch.at).toLocaleString()} · ${module.lastLaunch.status ?? ""}${module.lastLaunch.version ? ` · v${module.lastLaunch.version}` : ""}`
                  : text(language, "Never", "從未")}
              </dd>
            </div>
            <div>
              <dt>{text(language, "Ready timeout", "就緒逾時")}</dt>
              <dd>{module?.readyTimeoutMs ? `${Math.round(module.readyTimeoutMs / 1000)}s` : "—"}</dd>
            </div>
          </dl>
          {module && !module.planned && module.skipReason ? (
            <p className="module-controls-note">{skipReasonLabel(language, module.skipReason)}</p>
          ) : null}
          {module?.message ? <p className="module-controls-note is-error">{module.message}</p> : null}
          <div className="module-controls-actions">
            <label className="module-controls-toggle">
              <input
                checked={module?.autoStart ?? true}
                disabled={busy !== null || !module}
                onChange={(event) => void run("auto-start", async () => {
                  if (!api) throw new Error("Launcher IPC is unavailable");
                  setLaunch(await api.configureAppLaunch(moduleId, { autoStart: event.target.checked }));
                })}
                type="checkbox"
              />
              <span>{text(language, "Launch automatically after Coding Tools starts", "Coding Tools 啟動後自動啟動")}</span>
            </label>
            <button
              className="module-controls-button primary"
              disabled={busy !== null}
              onClick={() => void run("launch-now", async () => {
                if (!api) throw new Error("Launcher IPC is unavailable");
                setLaunch(await api.runAppsLaunch({ reason: "manual", moduleIds: [moduleId] }));
              })}
              type="button"
            >
              {busy === "launch-now" ? "…" : text(language, "Launch now", "立即啟動")}
            </button>
          </div>
        </article>

        <article className="module-controls-card">
          <h3>{text(language, "Lifecycle", "生命週期")}</h3>
          <p className="module-controls-muted">
            {text(language, "Managed by Coding Tools through", "由 Coding Tools 透過")} <code>codingTools.apps</code> · {catalog?.transport ?? "in-process"}
          </p>
          <div className="module-controls-actions wrap">
            {(lifecycle.length ? lifecycle : [...LIFECYCLE]).map((name) => (
              <button
                className="module-controls-button"
                disabled={busy !== null}
                key={name}
                onClick={() => void run(name, () => invoke(name), { keepResult: true })}
                type="button"
              >
                {busy === name ? "…" : name}
              </button>
            ))}
            <button
              className="module-controls-button"
              disabled={busy !== null}
              onClick={() => void run("inspect", () => invoke("inspect"), { keepResult: true })}
              type="button"
            >
              {busy === "inspect" ? "…" : "inspect"}
            </button>
          </div>
        </article>

        <article className="module-controls-card module-controls-api">
          <h3>{text(language, "APIs exposed to Coding Tools", "向 Coding Tools 公開的 API")}</h3>
          {apiOperations.length === 0 ? (
            <p className="module-controls-muted">
              {text(language, "Only lifecycle operations are declared for this module.", "此模組只宣告生命週期操作。")}
            </p>
          ) : (
            <ul>
              {apiOperations.map((operation) => (
                <li key={operation.name}>
                  <button
                    className="module-controls-op"
                    disabled={busy !== null}
                    onClick={() => void run(operation.name, () => invoke(operation.name), { keepResult: true })}
                    title={operation.description}
                    type="button"
                  >
                    <code>{operation.name}</code>
                    <em>{operation.readOnly ? text(language, "read", "讀取") : text(language, "write", "寫入")}</em>
                  </button>
                  {operation.description ? <small>{operation.description}</small> : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      {result ? <pre className="module-controls-result" tabIndex={0}>{result}</pre> : null}
    </section>
  );
}
