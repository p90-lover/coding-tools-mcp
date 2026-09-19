import { useEffect, useMemo, useState } from "react";
import type {
  ManagedAppOperation,
  ManagedAppSummary,
  ManagedAppsSnapshot,
} from "../api/contracts";
import type { Language, ManagedAppTabId } from "../types";
import { AnnealTasksSurface } from "./AnnealTasksSurface";
import { ExternalServicesSurface } from "./ExternalServicesSurface";
import { OriginalUiSurface } from "./OriginalUiSurface";
import { PaseoOrchestratorSurface } from "./PaseoOrchestratorSurface";
import { ProviderCenterSurface } from "./ProviderHubSaasSurface";
import { UpstreamToolSurface } from "./UpstreamToolSurface";
import "./managed-apps.css";

interface ManagedAppsSurfaceProps {
  language: Language;
  selectedTab: ManagedAppTabId;
  onSelectedTabChange: (tab: ManagedAppTabId) => void;
  setError: (error: string | null) => void;
}

interface ManagedAppTabDefinition {
  id: ManagedAppTabId;
  english: string;
  traditionalChinese: string;
}

const EMPTY_APPS: ManagedAppsSnapshot = {
  version: 1,
  bootstrap: { status: "idle", reason: null, startedAt: null, completedAt: null, error: null },
  apps: [],
};

const MANAGED_APP_TABS: readonly ManagedAppTabDefinition[] = [
  { id: "cpa", english: "CPA", traditionalChinese: "CPA" },
  {
    id: "codex-router",
    english: "Codex Router",
    traditionalChinese: "Codex Router",
  },
  {
    id: "commandcode-proxy",
    english: "CommandCode",
    traditionalChinese: "CommandCode",
  },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal" },
] as const;

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function appStatusLabel(language: Language, app: ManagedAppSummary | undefined): string {
  if (!app) return text(language, "Waiting for app controller", "正在等候應用程式控制器");
  if (app.setup.status === "blocked") {
    return text(language, "Setup needs input", "設定需要輸入");
  }
  if (app.setup.status === "error" || app.status === "error") {
    return app.error || app.setup.message || text(language, "Action required", "需要處理");
  }
  if (app.status === "ready") return text(language, "Ready", "已就緒");
  if (app.status === "starting") return text(language, "Starting", "正在啟動");
  if (app.managed.state === "not-installed") return text(language, "Not installed", "尚未安裝");
  if (app.managed.state === "repair-required") return text(language, "Repair required", "需要修復");
  return text(language, "Offline", "離線");
}

export function ManagedAppsSurface({
  language,
  selectedTab,
  onSelectedTabChange,
  setError,
}: ManagedAppsSurfaceProps) {
  const api = window.codingTools?.apps;
  const [snapshot, setSnapshot] = useState<ManagedAppsSnapshot>(EMPTY_APPS);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    if (!api) throw new Error("Coding Tools managed app API is unavailable");
    const next = await api.snapshot();
    setSnapshot(next);
    return next;
  };

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onChanged(setSnapshot);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError]);

  const appByHandle = useMemo(
    () => new Map(snapshot.apps.map((app) => [app.handle, app] as const)),
    [snapshot],
  );
  const selectedApp = appByHandle.get(selectedTab);

  const select = (tab: ManagedAppTabId) => {
    setNotice("");
    onSelectedTabChange(tab);
  };
  const sharedExternalProps = {
    language,
    openAnneal: () => select("anneal"),
    openCpa: () => select("cpa"),
    openCodexRouter: () => select("codex-router"),
    openPaseo: () => select("paseo"),
    openProviders: () => select("cpa"),
    setError,
  } as const;

  const runOperation = async (operation: ManagedAppOperation) => {
    if (!api || !selectedApp) throw new Error("Managed application controller is unavailable");
    setBusy(`${selectedTab}:${operation}`);
    setNotice("");
    setError(null);
    try {
      await api.invoke({
        handle: selectedTab,
        operation,
        confirm: operation !== "inspect",
      });
      await refresh();
      setNotice(text(
        language,
        `${selectedApp.name}: ${operation} completed.`,
        `${selectedApp.name}：${operation} 已完成。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const reconcileAll = async () => {
    if (!api) throw new Error("Coding Tools managed app API is unavailable");
    setBusy("reconcile-all");
    setNotice("");
    setError(null);
    try {
      await api.reconcile({
        reason: "managed-apps-toolbar",
        confirm: true,
      });
      await refresh();
      setNotice(text(
        language,
        "All managed apps were reconciled. Blocked apps remain visible with the required input.",
        "全部受管理應用程式已完成協調；被阻擋的應用程式會繼續顯示所需輸入。",
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const operationBusy = (operation: ManagedAppOperation) => busy === `${selectedTab}:${operation}`;
  const anyBusy = busy !== null;
  const operations = selectedApp?.operations ?? [];
  const canInspect = operations.includes("inspect");
  const canInstall = operations.includes("install");
  const canRepair = operations.includes("repair");
  const canStart = operations.includes("start");
  const canStop = operations.includes("stop");
  const canRestart = operations.includes("restart");
  const canSync = operations.includes("sync");
  const needsInstall = selectedApp?.managed.state === "not-installed";
  const needsRepair = selectedApp?.managed.state === "repair-required"
    || selectedApp?.managed.state === "error";
  const running = selectedApp?.status === "ready" || selectedApp?.status === "starting";

  return (
    <section className="managed-apps-surface">
      <header className="managed-apps-header">
        <div>
          <span>{text(language, "MANAGED APPS", "受管理應用程式")}</span>
          <h1>{text(language, "One window, every engine", "一個視窗，管理所有引擎")}</h1>
          <p>{text(
            language,
            "Manage CPA, Codex Router, CommandCode Proxy, Paseo and Anneal without leaving Coding Tools.",
            "毋須離開 Coding Tools，即可管理 CPA、Codex Router、CommandCode Proxy、Paseo 同 Anneal。",
          )}</p>
        </div>
      </header>

      <div
        aria-label={text(language, "Managed application tabs", "受管理應用程式分頁")}
        className="managed-app-tabs"
        role="tablist"
      >
        {MANAGED_APP_TABS.map((tab) => {
          const app = appByHandle.get(tab.id);
          const status = app?.status ?? "unknown";
          const managedState = app?.managed?.state;
          const setupStatus = app?.setup?.status;
          const actionRequired = status === "error"
            || managedState === "repair-required"
            || managedState === "error"
            || managedState === "unavailable"
            || setupStatus === "blocked"
            || setupStatus === "error";
          return (
            <button
              aria-controls={`managed-app-panel-${tab.id}`}
              aria-selected={selectedTab === tab.id}
              className={`managed-app-tab${selectedTab === tab.id ? " is-active" : ""}`}
              id={`managed-app-tab-${tab.id}`}
              key={tab.id}
              onClick={() => select(tab.id)}
              role="tab"
              type="button"
            >
              <i
                aria-hidden="true"
                className={`managed-app-status is-${actionRequired ? "action-required" : status}`}
              />
              <span>{text(language, tab.english, tab.traditionalChinese)}</span>
            </button>
          );
        })}
      </div>

      <section className="managed-app-toolbar" data-managed-app-handle={selectedTab}>
        <div className="managed-app-toolbar-status">
          <strong>{selectedApp?.name ?? selectedTab}</strong>
          <span>{appStatusLabel(language, selectedApp)}</span>
          {selectedApp?.setup.missingInputs.length ? (
            <small>{text(language, "Required", "需要")}: {selectedApp.setup.missingInputs.join(", ")}</small>
          ) : null}
        </div>
        <div className="managed-app-toolbar-actions">
          <button
            className="primary"
            disabled={anyBusy || !api}
            onClick={() => void reconcileAll()}
            type="button"
          >
            {busy === "reconcile-all"
              ? "…"
              : text(language, "Install and start all", "安裝並啟動全部")}
          </button>
          {canInspect ? (
            <button disabled={anyBusy} onClick={() => void runOperation("inspect")} type="button">
              {operationBusy("inspect") ? "…" : text(language, "Inspect", "檢查")}
            </button>
          ) : null}
          {canInstall && needsInstall ? (
            <button disabled={anyBusy} onClick={() => void runOperation("install")} type="button">
              {operationBusy("install") ? "…" : text(language, "Install", "安裝")}
            </button>
          ) : null}
          {canRepair && needsRepair ? (
            <button disabled={anyBusy} onClick={() => void runOperation("repair")} type="button">
              {operationBusy("repair") ? "…" : text(language, "Repair", "修復")}
            </button>
          ) : null}
          {canStart && !running && !needsInstall && !needsRepair ? (
            <button disabled={anyBusy} onClick={() => void runOperation("start")} type="button">
              {operationBusy("start") ? "…" : text(language, "Start", "啟動")}
            </button>
          ) : null}
          {canRestart && running ? (
            <button disabled={anyBusy} onClick={() => void runOperation("restart")} type="button">
              {operationBusy("restart") ? "…" : text(language, "Restart", "重新啟動")}
            </button>
          ) : null}
          {canStop && running ? (
            <button disabled={anyBusy} onClick={() => void runOperation("stop")} type="button">
              {operationBusy("stop") ? "…" : text(language, "Stop", "停止")}
            </button>
          ) : null}
          {canSync ? (
            <button disabled={anyBusy} onClick={() => void runOperation("sync")} type="button">
              {operationBusy("sync") ? "…" : text(language, "Sync providers", "同步供應商")}
            </button>
          ) : null}
        </div>
        {notice ? <p className="managed-app-toolbar-notice">{notice}</p> : null}
      </section>

      <div
        aria-labelledby={`managed-app-tab-${selectedTab}`}
        className="managed-app-panel"
        id={`managed-app-panel-${selectedTab}`}
        role="tabpanel"
      >
        {selectedTab === "cpa" ? (
          <div className="managed-app-composite" data-managed-app="cpa">
            <ProviderCenterSurface language={language} setError={setError} />
            <OriginalUiSurface language={language} setError={setError} toolId="cpa" />
          </div>
        ) : null}

        {selectedTab === "codex-router" ? (
          <div className="managed-app-composite" data-managed-app="codex-router">
            <ExternalServicesSurface {...sharedExternalProps} preferredServiceId="codex-router" />
            <OriginalUiSurface language={language} setError={setError} toolId="codex-router" />
          </div>
        ) : null}

        {selectedTab === "commandcode-proxy" ? (
          <ExternalServicesSurface {...sharedExternalProps} preferredServiceId="commandcode-proxy" />
        ) : null}

        {selectedTab === "paseo" ? (
          <UpstreamToolSurface
            language={language}
            nativeControl={<PaseoOrchestratorSurface language={language} setError={setError} />}
            setError={setError}
            toolId="paseo"
          />
        ) : null}

        {selectedTab === "anneal" ? (
          <UpstreamToolSurface
            language={language}
            nativeControl={<AnnealTasksSurface language={language} setError={setError} />}
            setError={setError}
            toolId="anneal"
          />
        ) : null}
      </div>
    </section>
  );
}
