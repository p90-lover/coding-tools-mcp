import { useState, type KeyboardEvent } from "react";
import type { Language } from "../types";
import { ProviderCenterSurface } from "./ProviderHubSaasSurface";
import { ExternalServicesSurface } from "./ExternalServicesSurface";
import { UpstreamToolSurface } from "./UpstreamToolSurface";
import { PaseoOrchestratorSurface } from "./PaseoOrchestratorSurface";
import { AnnealTasksSurface } from "./AnnealTasksSurface";
import "./integrated-apps.css";

export type IntegratedAppTab =
  | "cpa"
  | "codex-router"
  | "commandcode-proxy"
  | "paseo"
  | "anneal";

interface IntegratedAppsSurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
}

interface TabDefinition {
  id: IntegratedAppTab;
  english: string;
  traditionalChinese: string;
  short: string;
}

const STORAGE_KEY = "coding-tools-integrated-app-tab-v1";
const APP_TABS: readonly TabDefinition[] = [
  { id: "cpa", english: "CPA / Accounts", traditionalChinese: "CPA／帳戶", short: "CPA" },
  { id: "codex-router", english: "Codex Router", traditionalChinese: "Codex Router", short: "CR" },
  { id: "commandcode-proxy", english: "CommandCode Proxy", traditionalChinese: "CommandCode 代理", short: "CC" },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo", short: "PA" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal", short: "AN" },
];
const APP_TAB_IDS = new Set<IntegratedAppTab>(APP_TABS.map((tab) => tab.id));

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function initialTab(): IntegratedAppTab {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) as IntegratedAppTab | null;
    return stored && APP_TAB_IDS.has(stored) ? stored : "cpa";
  } catch {
    return "cpa";
  }
}

export function IntegratedAppsSurface({ language, setError }: IntegratedAppsSurfaceProps) {
  const [activeTab, setActiveTab] = useState<IntegratedAppTab>(initialTab);

  const selectTab = (tab: IntegratedAppTab) => {
    setActiveTab(tab);
    try {
      window.localStorage.setItem(STORAGE_KEY, tab);
    } catch {
      // A renderer preference failure must never block app navigation.
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = APP_TABS.findIndex((tab) => tab.id === activeTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? APP_TABS.length - 1
        : event.key === "ArrowLeft"
          ? (currentIndex - 1 + APP_TABS.length) % APP_TABS.length
          : (currentIndex + 1) % APP_TABS.length;
    const nextTab = APP_TABS[nextIndex];
    selectTab(nextTab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`integrated-app-tab-${nextTab.id}`)?.focus();
    });
  };

  const openCpa = () => selectTab("cpa");
  const openPaseo = () => selectTab("paseo");
  const openAnneal = () => selectTab("anneal");
  const activeDefinition = APP_TABS.find((tab) => tab.id === activeTab) ?? APP_TABS[0];

  return (
    <section className="integrated-apps-surface">
      <header className="integrated-apps-header">
        <div>
          <span className="integrated-apps-kicker">{text(language, "INTEGRATED APPS", "整合應用程式")}</span>
          <h1>{text(language, "Application workspace", "應用程式工作區")}</h1>
          <p>{text(
            language,
            "Switch between every managed Coding Tools application without leaving the desktop workspace.",
            "毋須離開桌面工作區，即可切換所有由 Coding Tools 管理的應用程式。",
          )}</p>
        </div>
      </header>

      <div
        aria-label={text(language, "Integrated applications", "整合應用程式")}
        className="integrated-app-tabs"
        onKeyDown={onTabKeyDown}
        role="tablist"
      >
        {APP_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              aria-controls={`integrated-app-panel-${tab.id}`}
              aria-selected={active}
              className={`integrated-app-tab${active ? " is-active" : ""}`}
              id={`integrated-app-tab-${tab.id}`}
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              <span className="integrated-app-tab-mark">{tab.short}</span>
              <span>{text(language, tab.english, tab.traditionalChinese)}</span>
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby={`integrated-app-tab-${activeTab}`}
        className="integrated-app-panel"
        id={`integrated-app-panel-${activeTab}`}
        role="tabpanel"
      >
        <h2 className="integrated-app-panel-title">
          {text(language, activeDefinition.english, activeDefinition.traditionalChinese)}
        </h2>
        <div className="integrated-app-panel-body">
          {activeTab === "cpa" ? (
            <ProviderCenterSurface language={language} setError={setError} />
          ) : null}
          {activeTab === "codex-router" ? (
            <ExternalServicesSurface
              focusServiceId="codex-router"
              language={language}
              openAnneal={openAnneal}
              openPaseo={openPaseo}
              openProviders={openCpa}
              setError={setError}
            />
          ) : null}
          {activeTab === "commandcode-proxy" ? (
            <ExternalServicesSurface
              focusServiceId="commandcode-proxy"
              language={language}
              openAnneal={openAnneal}
              openPaseo={openPaseo}
              openProviders={openCpa}
              setError={setError}
            />
          ) : null}
          {activeTab === "paseo" ? (
            <UpstreamToolSurface
              language={language}
              nativeControl={<PaseoOrchestratorSurface language={language} setError={setError} />}
              setError={setError}
              toolId="paseo"
            />
          ) : null}
          {activeTab === "anneal" ? (
            <UpstreamToolSurface
              language={language}
              nativeControl={<AnnealTasksSurface language={language} setError={setError} />}
              setError={setError}
              toolId="anneal"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
