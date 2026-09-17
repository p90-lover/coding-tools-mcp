import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROVIDER_CATALOG,
  type ProviderDefinition,
} from "../providers/provider-types";
import type {
  Language,
  ProviderAccountInput,
  ProviderAccountRecord,
  ProviderAccountStatus,
  ProviderAuth,
  ProviderExecutionWorkload,
  ProviderNetworkSnapshot,
} from "../types";
import "./provider-orchestrator.css";

interface SurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
}

interface WorkspaceOption {
  id: string;
  label: string;
}

interface ExecutionBinding {
  id: string;
  engine?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  enabled?: boolean;
  connected?: boolean;
  current_scope_valid?: boolean;
}

interface AccountDraft {
  id?: string;
  providerId: string;
  label: string;
  identity: string;
  auth: ProviderAuth;
  status: ProviderAccountStatus;
  enabled: boolean;
  isDefault: boolean;
  modelsText: string;
}

const EMPTY_SNAPSHOT: ProviderNetworkSnapshot = {
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

const ACCOUNT_STATUSES: readonly ProviderAccountStatus[] = [
  "pending",
  "connected",
  "expired",
  "error",
  "disabled",
];

const AUTH_TYPES: readonly ProviderAuth[] = [
  "oauth",
  "api_key",
  "browser_session",
  "local_proxy",
];

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function executionRoot(value: unknown): Record<string, unknown> {
  const root = object(value) ?? {};
  return object(root.execution) ?? root;
}

function executionRevision(value: unknown): number {
  const root = executionRoot(value);
  return typeof root.revision === "number" ? root.revision : 0;
}

function executionBindings(value: unknown): ExecutionBinding[] {
  const root = executionRoot(value);
  if (!Array.isArray(root.bindings)) return [];
  return root.bindings.flatMap((candidate) => {
    const row = object(candidate);
    if (!row || typeof row.id !== "string") return [];
    return [{
      id: row.id,
      engine: typeof row.engine === "string" ? row.engine : undefined,
      provider: typeof row.provider === "string" ? row.provider : undefined,
      model: typeof row.model === "string" ? row.model : undefined,
      endpoint: typeof row.endpoint === "string" ? row.endpoint : undefined,
      enabled: row.enabled === true,
      connected: row.connected === true,
      current_scope_valid: row.current_scope_valid === true,
    }];
  });
}

function providerDefinition(providerId: string): ProviderDefinition {
  return PROVIDER_CATALOG.find((candidate) => candidate.id === providerId)
    ?? PROVIDER_CATALOG[0];
}

function emptyDraft(providerId = PROVIDER_CATALOG[0].id): AccountDraft {
  const provider = providerDefinition(providerId);
  return {
    providerId: provider.id,
    label: provider.name,
    identity: "",
    auth: provider.auth,
    status: "pending",
    enabled: true,
    isDefault: false,
    modelsText: provider.models.join("\n"),
  };
}

function accountDraft(account: ProviderAccountRecord): AccountDraft {
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    identity: account.identity ?? "",
    auth: account.auth,
    status: account.status,
    enabled: account.enabled,
    isDefault: account.isDefault,
    modelsText: account.models.join("\n"),
  };
}

function parseModels(value: string): string[] {
  return [...new Set(value
    .split(/[\n,]/u)
    .map((model) => model.trim())
    .filter(Boolean))]
    .slice(0, 128);
}

function newestMatchingAccount(
  snapshot: ProviderNetworkSnapshot,
  input: ProviderAccountInput,
): ProviderAccountRecord | undefined {
  if (input.id) return snapshot.accounts.find((account) => account.id === input.id);
  return snapshot.accounts
    .filter((account) => (
      account.providerId === input.providerId
      && account.label === input.label
      && !account.archivedAt
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function bindingId(account: ProviderAccountRecord, workload: ProviderExecutionWorkload): string {
  return `${workload}-${account.providerId}-${account.id}`
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .slice(0, 100);
}

function defaultEngineEndpoint(workload: ProviderExecutionWorkload): string {
  return workload === "paseo"
    ? "ws://127.0.0.1:6767/ws"
    : "http://127.0.0.1:3000/";
}

function accountBadge(account: ProviderAccountRecord): string[] {
  const values = [account.auth.replaceAll("_", " "), account.status];
  if (account.isDefault) values.push("default");
  if (account.hasCredential) values.push("credential stored");
  return values;
}

export function ProviderCenterSurface({ language, setError }: SurfaceProps) {
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot>(EMPTY_SNAPSHOT);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [draft, setDraft] = useState<AccountDraft>(() => emptyDraft());
  const [secret, setSecret] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [bindings, setBindings] = useState<ExecutionBinding[]>([]);
  const [workload, setWorkload] = useState<ProviderExecutionWorkload>("anneal");
  const [engineEndpoint, setEngineEndpoint] = useState(defaultEngineEndpoint("anneal"));
  const [mode, setMode] = useState("default");
  const [projectId, setProjectId] = useState("");
  const [repoId, setRepoId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [allowProviderFallback, setAllowProviderFallback] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const activeAccounts = useMemo(() => snapshot.accounts.filter((account) => !account.archivedAt), [snapshot]);
  const providerAccountCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of activeAccounts) {
      counts.set(account.providerId, (counts.get(account.providerId) ?? 0) + 1);
    }
    return counts;
  }, [activeAccounts]);
  const activeProviderCount = providerAccountCounts.size;
  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
  const selectedProvider = providerDefinition(draft.providerId);

  const selectAccount = useCallback((account: ProviderAccountRecord) => {
    setSelectedAccountId(account.id);
    setDraft(accountDraft(account));
    setSecret("");
    setSelectedModel(account.models[0] ?? "");
    setNotice("");
  }, []);

  const adoptSnapshot = useCallback((next: ProviderNetworkSnapshot, preferredId?: string) => {
    setSnapshot(next);
    const currentId = preferredId ?? selectedAccountId;
    const selected = next.accounts.find((account) => account.id === currentId && !account.archivedAt)
      ?? next.accounts.find((account) => account.isDefault && !account.archivedAt)
      ?? next.accounts.find((account) => !account.archivedAt);
    if (selected) selectAccount(selected);
    else {
      setSelectedAccountId("");
      setDraft(emptyDraft());
      setSelectedModel("");
      setSecret("");
    }
  }, [selectAccount, selectedAccountId]);

  const refreshProviderHub = useCallback(async () => {
    const api = window.codexWebLauncher;
    if (!api) throw new Error("Provider Hub is unavailable in this window");
    const next = await api.providerSnapshot();
    adoptSnapshot(next);
    return next;
  }, [adoptSnapshot]);

  const refreshBindings = useCallback(async () => {
    const api = window.codingTools;
    if (!api || !workspaceId) {
      setBindings([]);
      return;
    }
    const value = await api.execution.read({
      workspaceId,
      missionId: null,
      refreshSource: false,
    });
    setBindings(executionBindings(value));
  }, [workspaceId]);

  useEffect(() => {
    const launcher = window.codexWebLauncher;
    if (!launcher) {
      setError("Provider Hub is unavailable in this window");
      return;
    }
    let active = true;
    void launcher.providerSnapshot()
      .then((next) => {
        if (active) adoptSnapshot(next);
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause));
      });
    const unsubscribe = launcher.onProviderNetworkChanged((next) => {
      if (active) adoptSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [adoptSnapshot, setError]);

  useEffect(() => {
    const api = window.codingTools;
    if (!api) return;
    let active = true;
    void api.workspaces.list({ limit: 100 })
      .then((page) => {
        if (!active) return;
        const options = page.items.map((workspace) => ({
          id: workspace.id,
          label: workspace.path ? `${workspace.name} · ${workspace.path}` : workspace.name,
        }));
        setWorkspaces(options);
        setWorkspaceId((current) => current || options[0]?.id || "");
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause));
      });
    return () => {
      active = false;
    };
  }, [setError]);

  useEffect(() => {
    void refreshBindings().catch((cause) => setError(messageOf(cause)));
  }, [refreshBindings, setError]);

  const startNewAccount = () => {
    setSelectedAccountId("");
    setDraft(emptyDraft());
    setSecret("");
    setSelectedModel("");
    setNotice("");
  };

  const persistAccount = async (): Promise<ProviderAccountRecord> => {
    const api = window.codexWebLauncher;
    if (!api) throw new Error("Provider Hub is unavailable in this window");
    if (!draft.label.trim()) throw new Error("Account label is required");
    const models = parseModels(draft.modelsText);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const status = requiresCredential && secret.trim() ? "connected" : draft.status;
    const input: ProviderAccountInput = {
      id: draft.id,
      providerId: draft.providerId,
      label: draft.label.trim(),
      identity: draft.identity.trim() || undefined,
      auth: draft.auth,
      status,
      enabled: draft.enabled,
      isDefault: draft.isDefault,
      models,
      ...(secret.trim() ? { secret: { credential: secret.trim() } } : {}),
    };
    const next = await api.saveProviderAccount(input);
    const saved = newestMatchingAccount(next, input);
    if (!saved) throw new Error("Provider Hub saved the account but did not return it");
    adoptSnapshot(next, saved.id);
    setSecret("");
    setSelectedModel((current) => current || saved.models[0] || "");
    return saved;
  };

  const saveAccount = async () => {
    setBusy("save-account");
    setError(null);
    try {
      const saved = await persistAccount();
      setNotice(text(language, `${saved.label} was saved securely.`, `${saved.label} 已安全儲存。`));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const openLogin = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setBusy("provider-login");
    setError(null);
    try {
      const saved = await persistAccount();
      await api.beginProviderLogin(saved.id);
      setNotice(text(
        language,
        "The provider login page was opened. Return here after signing in and mark the account connected.",
        "已開啟供應商登入頁。完成登入後返回此處，並將帳戶標記為已連線。",
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const setDefaultAccount = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedAccount) return;
    setBusy("default-account");
    setError(null);
    try {
      adoptSnapshot(await api.setDefaultProviderAccount(selectedAccount.providerId, selectedAccount.id), selectedAccount.id);
      setNotice(text(language, "Default account updated.", "預設帳戶已更新。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleAccountEnabled = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedAccount) return;
    setBusy("toggle-account");
    setError(null);
    try {
      adoptSnapshot(
        await api.setProviderAccountEnabled(selectedAccount.id, !selectedAccount.enabled),
        selectedAccount.id,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const archiveAccount = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedAccount) return;
    setBusy("archive-account");
    setError(null);
    try {
      const next = await api.archiveProviderAccount(selectedAccount.id);
      adoptSnapshot(next);
      setNotice(text(language, "Account archived without deleting retained data.", "帳戶已封存，保留資料並未刪除。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectProvider = async () => {
    const launcher = window.codexWebLauncher;
    const api = window.codingTools;
    if (!launcher || !api) throw new Error("Coding Tools execution bridge is unavailable");
    if (!selectedAccount) throw new Error("Save and select a Provider Hub account first");
    if (!workspaceId) throw new Error("Select a workspace before connecting a provider");
    if (!selectedAccount.enabled || selectedAccount.status !== "connected") {
      throw new Error("The selected Provider Hub account must be enabled and connected");
    }
    const model = selectedModel.trim() || selectedAccount.models[0] || "";
    if (!model) throw new Error("Select or enter a model for this account");
    if (workload === "anneal" && (!projectId.trim() || !repoId.trim() || !assigneeId.trim())) {
      throw new Error("Anneal requires project, repository and assigned agent IDs");
    }
    setBusy("connect-provider");
    setError(null);
    try {
      const plan = await launcher.providerExecutionPlan({
        workload,
        providerId: selectedAccount.providerId,
        accountId: selectedAccount.id,
        model,
        allowFallback: allowProviderFallback,
      });
      const current = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      await api.execution.provider({
        workspaceId,
        operation: "configure",
        expectedRevision: executionRevision(current),
        bindingId: null,
        providerAccountId: selectedAccount.id,
        allowProviderFallback,
        settings: {
          id: bindingId(selectedAccount, workload),
          engine: workload,
          endpoint: engineEndpoint,
          provider: selectedAccount.providerId,
          model,
          mode: mode.trim() || "default",
          projectId: workload === "anneal" ? projectId.trim() : null,
          repoId: workload === "anneal" ? repoId.trim() : null,
          assigneeId: workload === "anneal" ? assigneeId.trim() : null,
          maxDurationMin: 120,
          allowCodex: selectedAccount.providerId === "codex-oauth",
          confirmExternalExecution: true,
        },
        confirm: true,
      });
      await refreshBindings();
      setNotice(text(
        language,
        `${selectedAccount.label} is routed to ${workload} through ${plan.provider.name} / ${plan.account.label}.`,
        `${selectedAccount.label} 已透過 ${plan.provider.name}／${plan.account.label} 路由至 ${workload}。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectedBindingIds = useMemo(() => new Set(bindings
    .filter((binding) => binding.enabled && binding.connected && binding.current_scope_valid)
    .map((binding) => binding.id)), [bindings]);

  return (
    <section className="provider-surface">
      <header className="surface-heading provider-heading">
        <div>
          <span className="surface-kicker">PROVIDER HUB</span>
          <h1>{text(language, "Provider Center", "供應商中心")}</h1>
          <p>{text(
            language,
            "Manage multiple encrypted accounts per provider, then route an approved account and model into Paseo or Anneal.",
            "為每個供應商管理多個加密帳戶，再將已批准帳戶及模型路由至 Paseo 或 Anneal。",
          )}</p>
        </div>
        <button className="primary-button compact" onClick={startNewAccount} type="button">
          + {text(language, "Add account", "新增帳戶")}
        </button>
      </header>

      <div className="provider-toolbar">
        <label>
          <span>{text(language, "Workspace", "工作區")}</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">—</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.label}</option>
            ))}
          </select>
        </label>
        <button className="secondary-button" onClick={() => void refreshProviderHub().catch((cause) => setError(messageOf(cause)))} type="button">
          {text(language, "Refresh accounts", "刷新帳戶")}
        </button>
        <button className="secondary-button" onClick={() => void refreshBindings().catch((cause) => setError(messageOf(cause)))} type="button">
          {text(language, "Refresh bindings", "刷新綁定")}
        </button>
        <p className="inline-notice provider-account-summary" data-provider-account-summary>
          {text(
            language,
            `${activeAccounts.length} account${activeAccounts.length === 1 ? "" : "s"} across ${activeProviderCount} provider${activeProviderCount === 1 ? "" : "s"}`,
            `${activeAccounts.length} 個帳戶・${activeProviderCount} 個供應商`,
          )}
        </p>
        {notice ? <p className="inline-notice">{notice}</p> : null}
      </div>

      <div className="provider-layout">
        <div className="provider-card-grid">
          {activeAccounts.map((account) => {
            const provider = providerDefinition(account.providerId);
            const providerAccountCount = providerAccountCounts.get(account.providerId) ?? 0;
            const active = account.id === selectedAccountId;
            const connected = account.enabled && account.status === "connected";
            return (
              <button
                className={`provider-card${active ? " is-selected" : ""}`}
                key={account.id}
                onClick={() => selectAccount(account)}
                type="button"
              >
                <div className="provider-card-title">
                  <span className="provider-avatar">{account.label.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{account.label}</strong>
                    <small>{provider.name} · {account.identity || account.auth.replaceAll("_", " ")}</small>
                  </div>
                  <i className={connected ? "status-dot is-connected" : "status-dot"} />
                </div>
                <div className="capability-row">
                  {accountBadge(account).map((badge) => <span key={badge}>{badge}</span>)}
                </div>
                <footer>
                  <span>Paseo</span>
                  <span>Anneal</span>
                  <span>{text(
                    language,
                    `${providerAccountCount} account${providerAccountCount === 1 ? "" : "s"} · ${account.models.length} models`,
                    `${providerAccountCount} 個帳戶 · ${account.models.length} 個模型`,
                  )}</span>
                </footer>
              </button>
            );
          })}
          {activeAccounts.length === 0 ? (
            <article className="provider-card">
              <div className="provider-card-title">
                <span className="provider-avatar">+</span>
                <div>
                  <strong>{text(language, "No provider accounts", "未有供應商帳戶")}</strong>
                  <small>{text(language, "Create the first encrypted account.", "建立第一個加密帳戶。")}</small>
                </div>
              </div>
            </article>
          ) : null}
        </div>

        <aside className="provider-editor">
          <div className="provider-editor-heading">
            <div>
              <span className="surface-kicker">{selectedProvider.protocol.replaceAll("_", " ")}</span>
              <h2>{draft.id ? draft.label : text(language, "New provider account", "新增供應商帳戶")}</h2>
            </div>
            <span className={selectedAccount?.status === "connected" ? "provider-state is-connected" : "provider-state"}>
              {selectedAccount?.status ?? draft.status}
            </span>
          </div>

          <div className="editor-grid">
            <label>
              <span>{text(language, "Provider", "供應商")}</span>
              <select value={draft.providerId} onChange={(event) => {
                const provider = providerDefinition(event.target.value);
                setDraft((current) => ({
                  ...current,
                  providerId: provider.id,
                  auth: provider.auth,
                  label: current.id ? current.label : provider.name,
                  modelsText: current.id ? current.modelsText : provider.models.join("\n"),
                }));
              }}>
                {PROVIDER_CATALOG.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{text(language, "Account label", "帳戶名稱")}</span>
              <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} />
            </label>
            <label>
              <span>{text(language, "Identity / email", "身份／電郵")}</span>
              <input value={draft.identity} onChange={(event) => setDraft((current) => ({ ...current, identity: event.target.value }))} />
            </label>
            <label>
              <span>{text(language, "Authentication", "驗證方式")}</span>
              <select value={draft.auth} onChange={(event) => setDraft((current) => ({
                ...current,
                auth: event.target.value as ProviderAuth,
              }))}>
                {AUTH_TYPES.map((auth) => <option key={auth} value={auth}>{auth.replaceAll("_", " ")}</option>)}
              </select>
            </label>
            <label>
              <span>{text(language, "Connection status", "連線狀態")}</span>
              <select value={draft.status} onChange={(event) => setDraft((current) => ({
                ...current,
                status: event.target.value as ProviderAccountStatus,
              }))}>
                {ACCOUNT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label>
              <span>{text(language, "Task model", "任務模型")}</span>
              <input
                list="provider-hub-models"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              />
              <datalist id="provider-hub-models">
                {parseModels(draft.modelsText).map((model) => <option key={model} value={model} />)}
              </datalist>
            </label>
            <label className="full-row">
              <span>{text(language, "Account model catalogue (comma or line separated)", "帳戶模型清單（逗號或逐行分隔）")}</span>
              <input value={draft.modelsText} onChange={(event) => setDraft((current) => ({ ...current, modelsText: event.target.value }))} />
            </label>
            <label className="full-row">
              <span>{text(language, "Credential (encrypted by the Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
              <input
                autoComplete="off"
                placeholder={selectedAccount?.hasCredential ? text(language, "Stored — leave blank to keep it", "已儲存——留空即可保留") : ""}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                checked={draft.enabled}
                onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                type="checkbox"
              />
              <span>{text(language, "Account enabled", "啟用帳戶")}</span>
            </label>
            <label className="check-row">
              <input
                checked={draft.isDefault}
                onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))}
                type="checkbox"
              />
              <span>{text(language, "Default for this provider", "此供應商預設帳戶")}</span>
            </label>
          </div>

          <div className="provider-actions">
            {(draft.auth === "oauth" || draft.auth === "browser_session") ? (
              <button className="secondary-button" disabled={busy !== null} onClick={() => void openLogin()} type="button">
                {busy === "provider-login" ? "…" : text(language, "Save and open login", "儲存並開啟登入")}
              </button>
            ) : null}
            <button className="primary-button compact" disabled={busy !== null} onClick={() => void saveAccount()} type="button">
              {busy === "save-account" ? "…" : text(language, "Save account", "儲存帳戶")}
            </button>
          </div>

          {selectedAccount ? (
            <div className="provider-actions">
              <button className="secondary-button" disabled={busy !== null || selectedAccount.isDefault} onClick={() => void setDefaultAccount()} type="button">
                {text(language, "Set default", "設為預設")}
              </button>
              <button className="secondary-button" disabled={busy !== null} onClick={() => void toggleAccountEnabled()} type="button">
                {selectedAccount.enabled ? text(language, "Disable", "停用") : text(language, "Enable", "啟用")}
              </button>
              <button className="secondary-button" disabled={busy !== null} onClick={() => void archiveAccount()} type="button">
                {text(language, "Archive", "封存")}
              </button>
            </div>
          ) : null}

          <div className="binding-list">
            <h3>{text(language, "Paseo / Anneal routing", "Paseo／Anneal 路由")}</h3>
            <div className="editor-grid">
              <label>
                <span>{text(language, "Engine", "引擎")}</span>
                <select value={workload} onChange={(event) => {
                  const next = event.target.value as ProviderExecutionWorkload;
                  setWorkload(next);
                  setEngineEndpoint(defaultEngineEndpoint(next));
                }}>
                  <option value="paseo">Paseo</option>
                  <option value="anneal">Anneal</option>
                </select>
              </label>
              <label>
                <span>{text(language, "Engine endpoint", "引擎端點")}</span>
                <input value={engineEndpoint} onChange={(event) => setEngineEndpoint(event.target.value)} />
              </label>
              <label>
                <span>{text(language, "Mode", "模式")}</span>
                <input value={mode} onChange={(event) => setMode(event.target.value)} />
              </label>
              <label className="check-row">
                <input
                  checked={allowProviderFallback}
                  onChange={(event) => setAllowProviderFallback(event.target.checked)}
                  type="checkbox"
                />
                <span>{text(language, "Allow approved healthy-account fallback", "允許已批准健康帳戶後備路由")}</span>
              </label>
              {workload === "anneal" ? (
                <>
                  <label><span>Anneal project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
                  <label><span>Anneal repository ID</span><input value={repoId} onChange={(event) => setRepoId(event.target.value)} /></label>
                  <label className="full-row"><span>Anneal assigned agent ID</span><input value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} /></label>
                </>
              ) : null}
            </div>
            <div className="provider-actions">
              <button
                className="primary-button compact"
                disabled={busy !== null || !selectedAccount || !workspaceId}
                onClick={() => void connectProvider()}
                type="button"
              >
                {busy === "connect-provider" ? "…" : text(language, "Connect selected account", "連接所選帳戶")}
              </button>
            </div>

            <h3>{text(language, "Approved bindings", "已批准綁定")}</h3>
            {bindings.length === 0 ? <p>{text(language, "No bindings in this workspace.", "此工作區未有綁定。")}</p> : null}
            {bindings.map((binding) => (
              <article key={binding.id}>
                <div>
                  <strong>{binding.provider ?? binding.id} · {binding.model ?? "—"}</strong>
                  <small>{binding.engine ?? "—"} · {binding.endpoint ?? "—"}</small>
                </div>
                <span>{connectedBindingIds.has(binding.id)
                  ? text(language, "Connected", "已連線")
                  : text(language, "Pending", "等待中")}</span>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
