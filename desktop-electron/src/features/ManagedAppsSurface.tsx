import { useEffect, useMemo, useState } from "react";
import type { ManagedAppsSnapshot } from "../api/contracts";
import type { Language, ManagedAppTabId } from "../types";
import { AnnealTasksSurface } from "./AnnealTasksSurface";
import { ExternalServicesSurface } from "./ExternalServicesSurface";
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

const EMPTY_APPS: ManagedAppsSnapshot = { version: 1, apps: [] };

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

export function ManagedAppsSurface({
  language,
  selectedTab,
  onSelectedTabChange,
  setError,
}: ManagedAppsSurfaceProps) {
  const api = window.codingTools?.apps;
  const [snapshot, setSnapshot] = useState<ManagedAppsSnapshot>(EMPTY_APPS);

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

  return (
    <section className="managed-apps-surface">
      <header className="managed-apps-header">
        <div>
          <span>{text(language, "MANAGED APPS", "受管理應用程式")}</span>
          <h1>{text(language, "One window, every engine", "一個視窗，管理所有引擎")}</h1>
          <p>{text(
            language,
            "Switch between CPA, Codex Router, CommandCode Proxy, Paseo and Anneal without opening separate applications.",
            "直接喺同一個視窗切換 CPA、Codex Router、CommandCode Proxy、Paseo 同 Anneal，唔需要另外開啟程式。",
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
          const actionRequired = status === "error"
            || managedState === "repair-required"
            || managedState === "error"
            || managedState === "unavailable";
          return (
            <button
              aria-controls={`managed-app-panel-${tab.id}`}
              aria-selected={selectedTab === tab.id}
              className={`managed-app-tab${selectedTab === tab.id ? " is-active" : ""}`}
              id={`managed-app-tab-${tab.id}`}
              key={tab.id}
              onClick={() => onSelectedTabChange(tab.id)}
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

      <div
        aria-labelledby={`managed-app-tab-${selectedTab}`}
        className="managed-app-panel"
        id={`managed-app-panel-${selectedTab}`}
        role="tabpanel"
      >
        {selectedTab === "cpa" ? (
          <ProviderCenterSurface language={language} setError={setError} />
        ) : null}

        {selectedTab === "codex-router" ? (
          <ExternalServicesSurface
            language={language}
            openAnneal={() => onSelectedTabChange("anneal")}
            openPaseo={() => onSelectedTabChange("paseo")}
            openProviders={() => onSelectedTabChange("cpa")}
            preferredServiceId="codex-router"
            setError={setError}
          />
        ) : null}

        {selectedTab === "commandcode-proxy" ? (
          <ExternalServicesSurface
            language={language}
            openAnneal={() => onSelectedTabChange("anneal")}
            openPaseo={() => onSelectedTabChange("paseo")}
            openProviders={() => onSelectedTabChange("cpa")}
            preferredServiceId="commandcode-proxy"
            setError={setError}
          />
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
