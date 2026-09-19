import { useEffect, useMemo, useState } from "react";
import type { JsonObject } from "../api/contracts";
import type { Language } from "../types";
import "./cpa-original-panel.css";

export const CPA_PANEL_SECTIONS = [
  "dashboard",
  "ai-providers",
  "auth-files",
  "oauth",
  "quota",
  "config",
  "logs",
  "system",
  "plugins",
] as const;

export type CpaPanelSection = (typeof CPA_PANEL_SECTIONS)[number];

interface CpaOriginalPanelProps {
  language: Language;
  section?: string;
  compact?: boolean;
  onSectionChange?: (section: string) => void;
  setError?: (error: string | null) => void;
}

interface ProviderAccount {
  id?: string;
  providerId?: string;
  label?: string;
  identity?: string | null;
  status?: string;
  enabled?: boolean;
  archivedAt?: string | null;
  models?: string[];
  loginAdapterId?: string | null;
  credentialSource?: string | null;
  error?: string | null;
}

interface AuthFile {
  name: string;
  provider?: string | null;
  identity?: string | null;
  status?: string;
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function payloadOf(response: unknown): Record<string, unknown> {
  const root = asRecord(response);
  const nested = asRecord(root.result);
  return Object.keys(nested).length > 0 ? { ...root, ...nested } : root;
}

function isProtectedAccount(account: ProviderAccount): boolean {
  const providerId = String(account.providerId || "");
  const adapter = String(account.loginAdapterId || "");
  return providerId === "cliproxyapi-antigravity" || adapter.includes("antigravity");
}

async function invokeCpa(operation: string, args: JsonObject = {}): Promise<Record<string, unknown>> {
  const apps = window.codingTools?.apps;
  if (apps?.invoke) {
    return payloadOf(await apps.invoke({ handle: "cpa", operation, arguments: args }));
  }
  if (apps?.call) {
    return payloadOf(await apps.call({ moduleId: "cpa", operation, arguments: args }));
  }
  throw new Error("Coding Tools apps API is unavailable");
}

function sectionLabel(language: Language, section: string): string {
  const labels: Record<string, [string, string]> = {
    dashboard: ["Dashboard", "儀表板"],
    "ai-providers": ["AI providers", "AI 供應商"],
    "auth-files": ["Auth files", "驗證檔"],
    oauth: ["OAuth", "OAuth"],
    quota: ["Quota", "配額"],
    config: ["Config", "設定"],
    logs: ["Logs", "日誌"],
    system: ["System", "系統"],
    plugins: ["Plugins", "外掛"],
  };
  const pair = labels[section] || [section, section];
  return localize(language, pair[0], pair[1]);
}

export function CpaOriginalPanel({
  language,
  section = "dashboard",
  compact = false,
  onSectionChange,
  setError,
}: CpaOriginalPanelProps) {
  const selected = CPA_PANEL_SECTIONS.includes(section as CpaPanelSection)
    ? section
    : "dashboard";
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [inspect, setInspect] = useState<Record<string, unknown> | null>(null);
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelsReason, setModelsReason] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [statusReason, setStatusReason] = useState("");

  const authFiles = useMemo(
    () => (Array.isArray(health?.authFiles) ? health?.authFiles as AuthFile[] : []),
    [health],
  );

  const refresh = async () => {
    setBusy(true);
    setLocalError("");
    setError?.(null);
    try {
      const [inspected, listed, catalog, management, status] = await Promise.all([
        invokeCpa("inspect"),
        invokeCpa("listProviders"),
        invokeCpa("models"),
        invokeCpa("managementHealth"),
        invokeCpa("providerStatus"),
      ]);
      setInspect(inspected);
      setProviders(Array.isArray(listed.accounts) ? listed.accounts as ProviderAccount[] : []);
      setSummary(asRecord(listed.summary));
      setModels(Array.isArray(catalog.models) ? catalog.models.filter((value): value is string => typeof value === "string") : []);
      setModelsReason(typeof catalog.reason === "string" ? catalog.reason : "");
      setHealth(management);
      setStatusReason(typeof status.reason === "string" ? status.reason : "");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalError(message);
      setError?.(message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once per mount; section changes only swap the visible pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proxyNote = localize(
    language,
    "Proxy traffic can still use optional Start. This panel talks to codingTools.apps and does not need :8317.",
    "代理流量仍可稍後「啟動」。此面板透過 codingTools.apps 運作，不需要 :8317。",
  );

  const empty = (title: string, body: string) => (
    <div className="cpa-original-empty" data-empty="true">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );

  const dashboard = (
    <>
      <dl className="cpa-original-metrics">
        <div>
          <dt>{localize(language, "Handler", "處理常式")}</dt>
          <dd>{String(inspect?.transport || "in-process")}</dd>
        </div>
        <div>
          <dt>{localize(language, "Panel", "面板")}</dt>
          <dd>{health?.hosted === true || inspect?.ok !== false ? localize(language, "Hosted", "已內嵌") : localize(language, "Unavailable", "無法使用")}</dd>
        </div>
        <div>
          <dt>{localize(language, "Providers", "供應商")}</dt>
          <dd>{String(summary.connected ?? 0)} / {String(summary.total ?? 0)}</dd>
        </div>
        <div>
          <dt>{localize(language, "Models", "模型")}</dt>
          <dd>{models.length}</dd>
        </div>
        <div>
          <dt>{localize(language, "Proxy", "代理行程")}</dt>
          <dd>{health?.processReachable === true ? localize(language, "Listening", "監聽中") : localize(language, "Optional / stopped", "可選／已停止")}</dd>
        </div>
      </dl>
      {models.length > 0 ? (
        <ul className="cpa-original-chips">
          {models.map((model) => <li key={model}>{model}</li>)}
        </ul>
      ) : empty(
        localize(language, "No models yet", "尚未有模型"),
        modelsReason || localize(
          language,
          "Link a provider in Coding Tools. The optional CPA process is not required to browse this list.",
          "請在 Coding Tools 連結供應商。瀏覽此清單不必啟動 CPA 行程。",
        ),
      )}
      <p className="cpa-original-note">{proxyNote}</p>
    </>
  );

  const providerTable = providers.length === 0
    ? empty(
      localize(language, "No linked providers", "尚未連結供應商"),
      localize(language, "Provider-network is empty. Use Providers or OAuth to link an account. Antigravity credentials are left untouched.", "供應商網路是空的。請到 Providers 或 OAuth 連結帳戶。不會更動 Antigravity 憑證。"),
    )
    : (
      <table className="cpa-original-table">
        <thead>
          <tr>
            <th>{localize(language, "Account", "帳戶")}</th>
            <th>{localize(language, "Provider", "供應商")}</th>
            <th>{localize(language, "Status", "狀態")}</th>
            <th>{localize(language, "Models", "模型")}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((account) => (
            <tr key={account.id || account.label}>
              <td>
                {account.label || account.id || "—"}
                {isProtectedAccount(account) ? (
                  <div className="cpa-original-protected">{localize(language, "Antigravity account is read-only here", "此處的 Antigravity 帳戶為唯讀")}</div>
                ) : null}
              </td>
              <td>{account.providerId || account.credentialSource || "—"}</td>
              <td>{account.archivedAt ? "archived" : (account.status || (account.enabled ? "enabled" : "disabled"))}</td>
              <td>{Array.isArray(account.models) && account.models.length ? account.models.join(", ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  const body = (() => {
    if (selected === "dashboard") return dashboard;
    if (selected === "ai-providers") return providerTable;
    if (selected === "auth-files") {
      if (authFiles.length === 0) {
        return empty(
          localize(language, "No auth files", "沒有驗證檔"),
          typeof health?.reason === "string" && health.reason
            ? health.reason
            : localize(language, "Auth-dir listing needs the optional CPA process. Provider accounts above still come from Coding Tools.", "驗證檔清單需要可選的 CPA 行程。上方供應商帳戶仍來自 Coding Tools。"),
        );
      }
      return (
        <table className="cpa-original-table">
          <thead>
            <tr>
              <th>{localize(language, "File", "檔案")}</th>
              <th>{localize(language, "Provider", "供應商")}</th>
              <th>{localize(language, "Identity", "身分")}</th>
              <th>{localize(language, "Status", "狀態")}</th>
            </tr>
          </thead>
          <tbody>
            {authFiles.map((file) => (
              <tr key={file.name}>
                <td>{file.name}</td>
                <td>{file.provider || "—"}</td>
                <td>{file.identity || "—"}</td>
                <td>{file.status || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (selected === "oauth") {
      return empty(
        localize(language, "OAuth stays in Coding Tools", "OAuth 由 Coding Tools 管理"),
        localize(
          language,
          "Use the Providers surface to login-link accounts through codingTools.apps (linkProvider). This panel does not start CPA and does not unlink Antigravity OAuth.",
          "請在 Providers 透過 codingTools.apps（linkProvider）登入連結。此面板不會啟動 CPA，也不會解除 Antigravity OAuth。",
        ),
      );
    }
    return empty(
      sectionLabel(language, selected),
      statusReason || localize(
        language,
        "This original section is hosted in Coding Tools. Live proxy logs and quota need the optional CPA process; the rest of the panel stays usable.",
        "此原始分頁由 Coding Tools 內嵌。即時代理日誌與配額需要可選的 CPA 行程；其餘面板仍可使用。",
      ),
    );
  })();

  const navSections = compact ? ["dashboard", "ai-providers"] : [...CPA_PANEL_SECTIONS];

  return (
    <section
      className="cpa-original-panel"
      data-compact={compact ? "true" : "false"}
      data-section={selected}
      data-tool="cpa"
      data-transport="in-process"
      data-visual="in-process-panel"
    >
      <nav className="cpa-original-nav" aria-label={localize(language, "CPA sections", "CPA 分頁")}>
        {navSections.map((name) => (
          <button
            className={name === selected ? "is-active" : undefined}
            key={name}
            onClick={() => onSectionChange?.(name)}
            type="button"
          >
            {sectionLabel(language, name)}
          </button>
        ))}
      </nav>
      <div className="cpa-original-main">
        <div className="cpa-original-toolbar">
          <strong>{localize(language, "CPA / CLIProxyAPI", "CPA／CLIProxyAPI")}</strong>
          <button disabled={busy} onClick={() => void refresh()} type="button">
            {busy ? "…" : localize(language, "Refresh", "重新整理")}
          </button>
        </div>
        {localError ? <p className="cpa-original-error">{localError}</p> : null}
        <div className="cpa-original-body">{body}</div>
      </div>
    </section>
  );
}
