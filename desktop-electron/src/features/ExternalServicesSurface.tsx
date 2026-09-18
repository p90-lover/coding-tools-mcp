import { useEffect, useMemo, useState } from "react";
import type {
  ExternalServiceConfigurationInput,
  ExternalServiceId,
  ExternalServiceSnapshot,
  ExternalServicesSnapshot,
  Language,
  ProviderNetworkSnapshot,
} from "../types";
import "./external-services.css";

interface ExternalServicesSurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
  openProviders: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
}

interface ServiceDraft {
  endpoint: string;
  executionEndpoint: string;
  home: string;
  executable: string;
  argumentsText: string;
  enabled: boolean;
  autoStart: boolean;
  routerCli: string;
  curateCli: string;
  webBaseUrl: string;
}

const EMPTY_SERVICES: ExternalServicesSnapshot = { version: 1, services: [] };
const EMPTY_PROVIDERS: ProviderNetworkSnapshot = {
  version: 1,
  accounts: [],
  proxyProfiles: [],
  routing: {
    globalEnabled: false,
    globalProfileId: null,
    providers: [],
    accounts: [],
  },
};

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function draftFrom(service: ExternalServiceSnapshot): ServiceDraft {
  return {
    endpoint: service.endpoint,
    executionEndpoint: service.executionEndpoint ?? "",
    home: service.home,
    executable: service.executable,
    argumentsText: service.arguments.join("\n"),
    enabled: service.enabled,
    autoStart: service.autoStart,
    routerCli: service.routerCli ?? "model-router",
    curateCli: service.curateCli ?? "curate-models",
    webBaseUrl: service.webBaseUrl ?? "http://127.0.0.1:17841/router/v1",
  };
}

function serviceName(language: Language, id: ExternalServiceId): string {
  const names: Record<ExternalServiceId, [string, string]> = {
    "codex-router": ["Codex Router", "Codex Router"],
    "commandcode-proxy": ["CommandCode Proxy", "CommandCode 代理"],
    paseo: ["Paseo", "Paseo"],
    anneal: ["Anneal", "Anneal"],
  };
  const value = names[id];
  return text(language, value[0], value[1]);
}

function statusLabel(language: Language, service: ExternalServiceSnapshot): string {
  const labels: Record<ExternalServiceSnapshot["status"], [string, string]> = {
    unknown: ["Not checked", "尚未檢查"],
    disabled: ["Disabled", "已停用"],
    offline: ["Offline", "離線"],
    starting: ["Starting", "正在啟動"],
    ready: [service.owned ? "Running · app managed" : "Running · external", service.owned ? "運行中 · App 管理" : "運行中 · 外部管理"],
    error: ["Error", "錯誤"],
  };
  const value = labels[service.status];
  return text(language, value[0], value[1]);
}

function installStateLabel(language: Language, service: ExternalServiceSnapshot): string {
  const labels: Record<ExternalServiceSnapshot["managedInstall"]["state"], [string, string]> = {
    "not-installed": ["Not installed", "尚未安裝"],
    installing: ["Installing", "正在安裝"],
    installed: ["Managed install ready", "受管理安裝已就緒"],
    "repair-required": ["Repair required", "需要修復"],
    external: ["External install", "外部安裝"],
    error: ["Install error", "安裝錯誤"],
  };
  const value = labels[service.managedInstall.state];
  return text(language, value[0], value[1]);
}

function splitArguments(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 64);
}

export function ExternalServicesSurface({
  language,
  setError,
  openProviders,
  openPaseo,
  openAnneal,
}: ExternalServicesSurfaceProps) {
  const api = window.codexWebLauncher;
  const [services, setServices] = useState<ExternalServicesSnapshot>(EMPTY_SERVICES);
  const [providers, setProviders] = useState<ProviderNetworkSnapshot>(EMPTY_PROVIDERS);
  const [selectedId, setSelectedId] = useState<ExternalServiceId>("codex-router");
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [callerKey, setCallerKey] = useState("");
  const [managedCredential, setManagedCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const selected = services.services.find((service) => service.id === selectedId) ?? null;
  const activeAccounts = providers.accounts.filter((account) => !account.archivedAt);
  const connectedAccounts = activeAccounts.filter((account) => account.enabled && account.status === "connected");
  const providerCount = new Set(activeAccounts.map((account) => account.providerId)).size;
  const commandCodeAccounts = activeAccounts.filter((account) => account.providerId === "commandcode-proxy");
  const commandCodeModels = new Set(commandCodeAccounts.flatMap((account) => account.models)).size;

  const serviceRows = useMemo(() => services.services.map((service) => (
    service.id === "commandcode-proxy"
      ? {
          ...service,
          accountCount: commandCodeAccounts.length,
          connectedAccountCount: commandCodeAccounts.filter((account) => account.status === "connected").length,
          providerModelCount: commandCodeModels,
        }
      : service
  )), [services, commandCodeAccounts, commandCodeModels]);

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const [serviceSnapshot, providerSnapshot] = await Promise.all([
      api.externalServicesSnapshot(),
      api.providerSnapshot(),
    ]);
    setServices(serviceSnapshot);
    setProviders(providerSnapshot);
    const current = serviceSnapshot.services.find((service) => service.id === selectedId)
      ?? serviceSnapshot.services[0];
    if (current) {
      setSelectedId(current.id);
      setDraft(draftFrom(current));
    }
  };

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.externalServicesSnapshot(), api.providerSnapshot()]).then(([nextServices, nextProviders]) => {
      if (cancelled) return;
      setServices(nextServices);
      setProviders(nextProviders);
      const current = nextServices.services.find((service) => service.id === selectedId)
        ?? nextServices.services[0];
      if (current) {
        setSelectedId(current.id);
        setDraft(draftFrom(current));
      }
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribeServices = api.onExternalServicesChanged((next) => {
      setServices(next);
      const current = next.services.find((service) => service.id === selectedId);
      if (current) setDraft(draftFrom(current));
    });
    const unsubscribeProviders = api.onProviderNetworkChanged(setProviders);
    return () => {
      cancelled = true;
      unsubscribeServices();
      unsubscribeProviders();
    };
  }, [api, selectedId, setError]);

  useEffect(() => {
    if (selected) {
      setDraft(draftFrom(selected));
      setCallerKey("");
      setManagedCredential("");
      setNotice("");
    }
  }, [selectedId]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (!api || busy) return;
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

  const save = () => run("save", async () => {
    if (!api || !draft || !selected) return;
    const input: ExternalServiceConfigurationInput = {
      endpoint: draft.endpoint,
      ...((selected.id === "paseo" || selected.id === "anneal")
        ? { executionEndpoint: draft.executionEndpoint }
        : {}),
      home: draft.home,
      executable: draft.executable,
      arguments: splitArguments(draft.argumentsText),
      enabled: draft.enabled,
      autoStart: draft.autoStart,
      ...(selected.id === "codex-router" ? {
        routerCli: draft.routerCli,
        curateCli: draft.curateCli,
        webBaseUrl: draft.webBaseUrl,
        ...(callerKey.trim() ? { callerKey: callerKey.trim() } : {}),
      } : {}),
    };
    await api.configureExternalService(selected.id, input);
    setCallerKey("");
    setNotice(text(language, "Service configuration saved.", "已儲存服務設定。"));
  });

  const inspect = () => run("inspect", async () => {
    if (!api || !selected) return;
    await api.inspectExternalService(selected.id);
  });

  const start = () => run("start", async () => {
    if (!api || !selected) return;
    await api.startExternalService(selected.id);
  });

  const stop = () => run("stop", async () => {
    if (!api || !selected) return;
    await api.stopExternalService(selected.id);
  });

  const restart = () => run("restart", async () => {
    if (!api || !selected) return;
    await api.restartExternalService(selected.id);
  });

  const saveManagedCredential = () => run("managed-credential", async () => {
    if (!api || !selected || selected.id !== "anneal") return;
    const value = managedCredential.trim();
    if (!value) throw new Error(text(language, "Enter a GitHub read token first.", "請先輸入 GitHub 唯讀 Token。"));
    await api.setManagedComponentCredential("anneal", "githubReadToken", value);
    setManagedCredential("");
    setNotice(text(language, "Anneal credential saved securely.", "Anneal 憑證已安全儲存。"));
  });

  const installOrRepair = () => run("managed-install", async () => {
    if (!api || !selected) return;
    const repair = selected.managedInstall.state === "repair-required"
      || selected.managedInstall.state === "error";
    if (repair) await api.repairManagedComponent(selected.id);
    else await api.installManagedComponent(selected.id);
    setNotice(text(
      language,
      `${serviceName(language, selected.id)} is installed and started by Coding Tools.`,
      `${serviceName(language, selected.id)} 已由 Coding Tools 安裝並啟動。`,
    ));
  });

  const syncRouter = () => run("sync", async () => {
    if (!api) return;
    const result = await api.syncCodexRouter();
    setNotice(result.stdout?.trim() || text(language, "Codex Router integration synchronized.", "Codex Router 整合已同步。"));
  });

  const openSelected = () => {
    if (!selected) return;
    if (selected.id === "paseo") openPaseo();
    else if (selected.id === "anneal") openAnneal();
    else openProviders();
  };

  return (
    <section className="external-services-surface">
      <header className="external-services-heading">
        <div>
          <span>{text(language, "EXTERNAL SERVICES", "外部服務")}</span>
          <h1>{text(language, "Integrations Control Plane", "整合服務控制台")}</h1>
          <p>{text(
            language,
            "Install, repair and run Codex Router, CommandCode Proxy, Paseo and Anneal from Coding Tools while CPA Provider Hub remains the encrypted account and routing authority.",
            "直接由 Coding Tools 安裝、修復同執行 Codex Router、CommandCode Proxy、Paseo 與 Anneal；CPA 供應商中心繼續作為加密帳戶同路由權限來源。",
          )}</p>
        </div>
        <button disabled={busy !== null} onClick={() => void refresh()} type="button">
          {text(language, "Refresh all", "全部刷新")}
        </button>
      </header>

      <div className="external-services-summary">
        <article className="external-service-card native-card">
          <div className="external-service-card-title">
            <span className="external-service-glyph">CPA</span>
            <div>
              <strong>CPA Provider Hub</strong>
              <small>{text(language, "Native encrypted account authority", "原生加密帳戶權限中心")}</small>
            </div>
            <i className="service-state ready" />
          </div>
          <dl>
            <div><dt>{text(language, "Accounts", "帳戶")}</dt><dd>{activeAccounts.length}</dd></div>
            <div><dt>{text(language, "Connected", "已連線")}</dt><dd>{connectedAccounts.length}</dd></div>
            <div><dt>{text(language, "Providers", "供應商")}</dt><dd>{providerCount}</dd></div>
          </dl>
          <button onClick={openProviders} type="button">{text(language, "Open Provider Center", "開啟供應商中心")}</button>
        </article>

        {serviceRows.map((service) => (
          <button
            className={`external-service-card${selectedId === service.id ? " is-selected" : ""}`}
            key={service.id}
            onClick={() => setSelectedId(service.id)}
            type="button"
          >
            <div className="external-service-card-title">
              <span className="external-service-glyph">{service.name.split(/\s+/u).map((word) => word[0]).slice(0, 2).join("")}</span>
              <div>
                <strong>{serviceName(language, service.id)}</strong>
                <small>{statusLabel(language, service)} · {installStateLabel(language, service)}</small>
              </div>
              <i className={`service-state ${service.status}`} />
            </div>
            <dl>
              <div><dt>{text(language, "PID", "PID")}</dt><dd>{service.pid ?? "—"}</dd></div>
              <div><dt>{text(language, "Accounts", "帳戶")}</dt><dd>{service.accountCount ?? "—"}</dd></div>
              <div><dt>{text(language, "Models", "模型")}</dt><dd>{service.modelCount ?? service.providerModelCount ?? "—"}</dd></div>
            </dl>
          </button>
        ))}
      </div>

      {selected && draft ? (
        <div className="external-services-editor">
          <header>
            <div>
              <span>{text(language, "LOCAL SERVICE", "本機服務")}</span>
              <h2>{serviceName(language, selected.id)}</h2>
              <p>{selected.endpoint}</p>
            </div>
            <span className={`external-service-status status-${selected.status}`}>{statusLabel(language, selected)}</span>
          </header>

          <section className={`managed-install-panel state-${selected.managedInstall.state}`}>
            <div>
              <span>{text(language, "APP-MANAGED COMPONENT", "APP 受管理元件")}</span>
              <strong>{installStateLabel(language, selected)}</strong>
              <small>
                {text(language, "Pinned version", "固定版本")} {selected.managedInstall.version}
                {selected.managedInstall.commit ? ` · ${selected.managedInstall.commit.slice(0, 12)}` : ""}
                {selected.managedInstall.platformMode === "wsl2" ? " · WSL2" : ""}
              </small>
              {selected.managedInstall.currentStep ? <small>{text(language, "Current step", "目前步驟")}: {selected.managedInstall.currentStep}</small> : null}
              {selected.managedInstall.error ? <small className="managed-install-error">{selected.managedInstall.error}</small> : null}
            </div>
            {selected.id === "anneal" ? (
              <label className="managed-secret-field">
                <span>{text(
                  language,
                  selected.managedInstall.missingCredentials.includes("githubReadToken")
                    ? "GitHub read token required"
                    : "Replace GitHub read token",
                  selected.managedInstall.missingCredentials.includes("githubReadToken")
                    ? "需要 GitHub 唯讀 Token"
                    : "取代 GitHub 唯讀 Token",
                )}</span>
                <input
                  autoComplete="off"
                  type="password"
                  value={managedCredential}
                  onChange={(event) => setManagedCredential(event.target.value)}
                />
                <button disabled={busy !== null || !managedCredential.trim()} onClick={() => void saveManagedCredential()} type="button">
                  {busy === "managed-credential" ? "…" : text(language, "Save credential", "儲存憑證")}
                </button>
              </label>
            ) : null}
            <button
              className="primary"
              disabled={busy !== null
                || selected.managedInstall.state === "installing"
                || selected.managedInstall.missingCredentials.length > 0}
              onClick={() => void installOrRepair()}
              type="button"
            >
              {busy === "managed-install" || selected.managedInstall.state === "installing"
                ? "…"
                : selected.managedInstall.state === "installed"
                  ? text(language, "Repair installation", "修復安裝")
                  : text(language, "Install / Repair", "安裝／修復")}
            </button>
          </section>

          <details className="external-service-advanced">
            <summary>{text(language, "Advanced manual configuration", "進階手動設定")}</summary>
            <div className="external-service-form">
            <label className="wide-field">
              <span>{text(language, "Loopback endpoint", "Loopback 端點")}</span>
              <input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
            </label>
            {selected.id === "paseo" || selected.id === "anneal" ? (
              <label className="wide-field">
                <span>{text(language, "Execution endpoint", "執行端點")}</span>
                <input
                  value={draft.executionEndpoint}
                  onChange={(event) => setDraft({ ...draft, executionEndpoint: event.target.value })}
                />
              </label>
            ) : null}
            <label>
              <span>{text(language, "Source / working directory", "原始碼／工作目錄")}</span>
              <input value={draft.home} onChange={(event) => setDraft({ ...draft, home: event.target.value })} />
            </label>
            <label>
              <span>{text(language, "Executable", "執行檔")}</span>
              <input value={draft.executable} onChange={(event) => setDraft({ ...draft, executable: event.target.value })} />
            </label>
            <label className="wide-field">
              <span>{text(language, "Arguments — one per line", "參數 — 每行一個")}</span>
              <textarea value={draft.argumentsText} onChange={(event) => setDraft({ ...draft, argumentsText: event.target.value })} />
            </label>
            {selected.id === "codex-router" ? (
              <>
                <label>
                  <span>{text(language, "Router CLI", "Router CLI")}</span>
                  <input value={draft.routerCli} onChange={(event) => setDraft({ ...draft, routerCli: event.target.value })} />
                </label>
                <label>
                  <span>{text(language, "Model curation CLI", "模型整理 CLI")}</span>
                  <input value={draft.curateCli} onChange={(event) => setDraft({ ...draft, curateCli: event.target.value })} />
                </label>
                <label className="wide-field">
                  <span>{text(language, "Coding Tools Web provider URL", "Coding Tools Web 供應商 URL")}</span>
                  <input value={draft.webBaseUrl} onChange={(event) => setDraft({ ...draft, webBaseUrl: event.target.value })} />
                </label>
                <label className="wide-field">
                  <span>{text(
                    language,
                    selected.secretConfigured ? "Replace caller key (leave blank to keep current)" : "Codex Router caller key",
                    selected.secretConfigured ? "取代 Caller Key（留空以保留目前設定）" : "Codex Router Caller Key",
                  )}</span>
                  <input autoComplete="off" type="password" value={callerKey} onChange={(event) => setCallerKey(event.target.value)} />
                </label>
              </>
            ) : null}
            <label className="service-check"><input checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} type="checkbox" /><span>{text(language, "Enabled", "已啟用")}</span></label>
            <label className="service-check"><input checked={draft.autoStart} onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })} type="checkbox" /><span>{text(language, "Start with Coding Tools", "隨 Coding Tools 啟動")}</span></label>
            </div>
          </details>

          {selected.error ? <p className="external-service-error">{selected.error}</p> : null}
          {notice ? <p className="external-service-notice">{notice}</p> : null}

          <div className="external-service-actions">
            <button disabled={busy !== null} onClick={() => void save()} type="button">{busy === "save" ? "…" : text(language, "Save", "儲存")}</button>
            <button disabled={busy !== null || !selected.enabled} onClick={() => void inspect()} type="button">{busy === "inspect" ? "…" : text(language, "Check", "檢查")}</button>
            <button disabled={busy !== null || !selected.enabled || selected.status === "ready"} onClick={() => void start()} type="button">{busy === "start" ? "…" : text(language, "Start", "啟動")}</button>
            <button disabled={busy !== null || !selected.owned} onClick={() => void restart()} type="button">{busy === "restart" ? "…" : text(language, "Restart", "重新啟動")}</button>
            <button disabled={busy !== null || !selected.owned} onClick={() => void stop()} type="button">{busy === "stop" ? "…" : text(language, "Stop", "停止")}</button>
            {selected.id === "codex-router" ? (
              <button className="primary" disabled={busy !== null || !selected.secretConfigured} onClick={() => void syncRouter()} type="button">
                {busy === "sync" ? "…" : text(language, "Sync Coding Tools + CommandCode", "同步 Coding Tools + CommandCode")}
              </button>
            ) : null}
            <button onClick={openSelected} type="button">{text(language, "Open related controls", "開啟相關控制")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
