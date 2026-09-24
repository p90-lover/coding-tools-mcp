import type { Language, ProviderAccountRecord, ProviderAccountStatus } from "../types";

/**
 * SaaS-style "Connection" clause for a provider account, modelled on the CPA
 * (CLIProxyAPI) provider cards: one status pill, the endpoint that will be
 * called, how the account authenticates, whether a credential is stored, the
 * live model catalogue and the connection actions — instead of a bare status
 * dropdown buried in a form grid.
 */
export interface ProviderConnectionCardProps {
  language: Language;
  status: ProviderAccountStatus;
  statusText: string;
  enabled: boolean;
  endpoint: string;
  endpointPlaceholder: string;
  endpointEditable: boolean;
  authText: string;
  loginSourceText: string | null;
  protocolText: string;
  hasCredential: boolean;
  credentialSource: string | null;
  modelCount: number;
  account: ProviderAccountRecord | null;
  busy: string | null;
  canTest: boolean;
  canLogin: boolean;
  loginLabel: string;
  statusOptions: Array<{ value: ProviderAccountStatus; label: string }>;
  managedByCodingTools: boolean;
  onEndpointChange: (value: string) => void;
  onStatusChange: (value: ProviderAccountStatus) => void;
  onTest: () => void;
  onLogin: () => void;
}

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function endpointKind(language: Language, endpoint: string): { label: string; tone: "local" | "remote" | "empty" } {
  const value = endpoint.trim();
  if (!value) return { label: text(language, "No endpoint", "尚未設定端點"), tone: "empty" };
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
      return { label: text(language, "Local loopback", "本機 loopback"), tone: "local" };
    }
    return { label: parsed.protocol === "https:" ? "HTTPS" : parsed.protocol.replace(":", "").toUpperCase(), tone: "remote" };
  } catch {
    return { label: text(language, "Custom", "自訂"), tone: "remote" };
  }
}

function relativeTime(language: Language, iso: string | undefined): string {
  if (!iso) return text(language, "Never", "從未");
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return text(language, "just now", "剛剛");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return text(language, `${minutes} min ago`, `${minutes} 分鐘前`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return text(language, `${hours} h ago`, `${hours} 小時前`);
  return new Date(then).toLocaleDateString();
}

export function ProviderConnectionCard({
  language,
  status,
  statusText,
  enabled,
  endpoint,
  endpointPlaceholder,
  endpointEditable,
  authText,
  loginSourceText,
  protocolText,
  hasCredential,
  credentialSource,
  modelCount,
  account,
  busy,
  canTest,
  canLogin,
  loginLabel,
  statusOptions,
  managedByCodingTools,
  onEndpointChange,
  onStatusChange,
  onTest,
  onLogin,
}: ProviderConnectionCardProps) {
  const effectiveStatus: ProviderAccountStatus = enabled ? status : "disabled";
  const kind = endpointKind(language, endpoint);
  const headline = effectiveStatus === "connected"
    ? text(language, "Live and routing requests", "已連線並可路由請求")
    : effectiveStatus === "expired"
      ? text(language, "Session expired — refresh to reconnect", "工作階段已過期——請重新整理以重新連線")
      : effectiveStatus === "error"
        ? text(language, "Last connection attempt failed", "上次連線嘗試失敗")
        : effectiveStatus === "disabled"
          ? text(language, "Disabled — not used for routing", "已停用——不會用於路由")
          : hasCredential
            ? text(language, "Credential stored — test to verify", "已儲存憑證——請測試以驗證")
            : text(language, "Waiting for a credential or login", "等待憑證或登入");

  return (
    <section className="provider-connection-card" data-status={effectiveStatus} aria-label={text(language, "Connection", "連線")}>
      <header className="provider-connection-header">
        <div className="provider-connection-title">
          <span className="provider-connection-eyebrow">{text(language, "CONNECTION", "連線")}</span>
          <strong>{headline}</strong>
        </div>
        <span className={`provider-connection-pill is-${effectiveStatus}`}>
          <i aria-hidden="true" />
          {statusText}
        </span>
      </header>

      <div className="provider-connection-grid">
        <label className="provider-connection-endpoint">
          <span>{text(language, "Endpoint", "端點")}</span>
          <div className="provider-connection-endpoint-row">
            <em className={`provider-connection-chip is-${kind.tone}`}>{kind.label}</em>
            <input
              placeholder={endpointPlaceholder}
              readOnly={!endpointEditable}
              value={endpoint}
              onChange={(event) => onEndpointChange(event.target.value)}
            />
          </div>
          {managedByCodingTools ? (
            <small>{text(language, "Managed inside Coding Tools; no separate server to run.", "由 Coding Tools 內部管理；不需另外執行伺服器。")}</small>
          ) : null}
        </label>

        <dl className="provider-connection-facts">
          <div>
            <dt>{text(language, "Authentication", "驗證方式")}</dt>
            <dd>{authText}{loginSourceText ? <small> · {loginSourceText}</small> : null}</dd>
          </div>
          <div>
            <dt>{text(language, "Request format", "請求格式")}</dt>
            <dd>{protocolText}</dd>
          </div>
          <div>
            <dt>{text(language, "Credential", "憑證")}</dt>
            <dd className={hasCredential ? "is-ok" : "is-missing"}>
              {hasCredential
                ? text(language, "Stored (encrypted)", "已儲存（已加密）")
                : text(language, "Not stored", "未儲存")}
              {credentialSource ? <small> · {credentialSource}</small> : null}
            </dd>
          </div>
          <div>
            <dt>{text(language, "Models", "模型")}</dt>
            <dd>{modelCount} {text(language, "in catalogue", "個可用")}</dd>
          </div>
          <div>
            <dt>{text(language, "Last used", "上次使用")}</dt>
            <dd>{relativeTime(language, account?.lastUsedAt)}</dd>
          </div>
          <div>
            <dt>{text(language, "Updated", "更新時間")}</dt>
            <dd>{relativeTime(language, account?.updatedAt)}</dd>
          </div>
        </dl>
      </div>

      {account?.error ? <p className="provider-connection-error" role="alert">{account.error}</p> : null}

      <footer className="provider-connection-actions">
        <label className="provider-connection-override">
          <span>{text(language, "Mark status", "標記狀態")}</span>
          <select value={status} onChange={(event) => onStatusChange(event.target.value as ProviderAccountStatus)}>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div>
          {canTest ? (
            <button className="provider-secondary-button" disabled={busy !== null} onClick={onTest} type="button">
              {busy === "provider-probe" ? "…" : text(language, "Test connection", "測試連線")}
            </button>
          ) : null}
          {canLogin ? (
            <button className="provider-primary-button" disabled={busy !== null} onClick={onLogin} type="button">
              {busy === "provider-login" ? "…" : loginLabel}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
