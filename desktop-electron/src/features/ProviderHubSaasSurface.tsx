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
import "./provider-hub-saas.css";

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
  endpoint: string;
  auth: ProviderAuth;
  status: ProviderAccountStatus;
  enabled: boolean;
  isDefault: boolean;
  modelsText: string;
}

interface ProviderPresentation {
  english: string;
  traditionalChinese: string;
  descriptionEnglish: string;
  descriptionTraditionalChinese: string;
  aliases: readonly string[];
}

type ProviderCategoryFilter = "all" | ProviderDefinition["category"];

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

const PROVIDER_FILTERS: readonly ProviderCategoryFilter[] = [
  "all",
  "oauth",
  "api_key",
  "browser",
  "reverse_proxy",
  "custom",
];

const PROVIDER_PRESENTATION: Readonly<Record<string, ProviderPresentation>> = {
  "codex-oauth": {
    english: "Codex OAuth",
    traditionalChinese: "Codex OAuth",
    descriptionEnglish: "Sign in with one or more Codex accounts and route tasks without exposing OAuth tokens to the renderer.",
    descriptionTraditionalChinese: "登入一個或多個 Codex 帳戶，並在不向 renderer 暴露 OAuth token 的情況下路由任務。",
    aliases: ["openai codex", "codex login", "oauth"],
  },
  "claude-oauth": {
    english: "Claude OAuth",
    traditionalChinese: "Claude OAuth",
    descriptionEnglish: "Manage multiple Claude sign-ins for approved Paseo and Anneal workloads.",
    descriptionTraditionalChinese: "管理多個 Claude 登入帳戶，供已批准的 Paseo 與 Anneal 工作使用。",
    aliases: ["anthropic claude", "claude login", "oauth"],
  },
  "chatgpt-web": {
    english: "ChatGPT Web",
    traditionalChinese: "ChatGPT Web",
    descriptionEnglish: "Use the authenticated browser session as a managed provider account.",
    descriptionTraditionalChinese: "將已驗證的瀏覽器 Session 作為受管理供應商帳戶使用。",
    aliases: ["chatgpt browser", "web gpt", "browser session"],
  },
  "openai-api": {
    english: "OpenAI API",
    traditionalChinese: "OpenAI API",
    descriptionEnglish: "Store OpenAI API credentials through the encrypted Electron main-process boundary.",
    descriptionTraditionalChinese: "透過加密 Electron 主程序邊界儲存 OpenAI API 憑證。",
    aliases: ["openai key", "responses api", "api key"],
  },
  "anthropic-api": {
    english: "Anthropic API",
    traditionalChinese: "Anthropic API",
    descriptionEnglish: "Connect Anthropic API accounts with per-account model and routing policies.",
    descriptionTraditionalChinese: "連接 Anthropic API 帳戶，並設定每個帳戶的模型與路由政策。",
    aliases: ["claude api", "anthropic key", "api key"],
  },
  "gemini-api": {
    english: "Gemini API",
    traditionalChinese: "Gemini API",
    descriptionEnglish: "Connect Gemini API credentials and model catalogues.",
    descriptionTraditionalChinese: "連接 Gemini API 憑證與模型清單。",
    aliases: ["google gemini", "gemini key", "api key"],
  },
  "ai-studio-reverse-proxy": {
    english: "AI Studio Reverse Proxy",
    traditionalChinese: "AI Studio 反向代理",
    descriptionEnglish: "Manage browser-backed AI Studio reverse-proxy accounts.",
    descriptionTraditionalChinese: "管理由瀏覽器 Session 支援的 AI Studio 反向代理帳戶。",
    aliases: ["google ai studio", "aistudio reverse proxy", "gemini reverse"],
  },
  "gemini-reverse-proxy": {
    english: "Gemini Reverse Proxy",
    traditionalChinese: "Gemini 反向代理",
    descriptionEnglish: "Route Gemini-compatible traffic through a local reverse-proxy account.",
    descriptionTraditionalChinese: "透過本機反向代理帳戶路由 Gemini-compatible 流量。",
    aliases: ["gemini proxy", "google reverse proxy", "v1beta"],
  },
  "aistudio-to-api": {
    english: "AIStudioToAPI",
    traditionalChinese: "AIStudioToAPI",
    descriptionEnglish: "Expose AI Studio through an OpenAI-compatible local API bridge.",
    descriptionTraditionalChinese: "透過 OpenAI-compatible 本機 API bridge 使用 AI Studio。",
    aliases: ["ai studio to api", "aistudio api bridge"],
  },
  "cliproxyapi-antigravity": {
    english: "Gemini Antigravity Reverse Proxy",
    traditionalChinese: "Gemini Antigravity 反向代理",
    descriptionEnglish: "Manage CLIProxyAPI / Antigravity accounts as an explicit Gemini reverse-proxy provider.",
    descriptionTraditionalChinese: "將 CLIProxyAPI／Antigravity 帳戶作為明確的 Gemini 反向代理供應商管理。",
    aliases: ["cliproxyapi", "antigravity", "gemini antigravity", "cli proxy api"],
  },
  "commandcode-proxy": {
    english: "CommandCode Proxy",
    traditionalChinese: "CommandCode 代理",
    descriptionEnglish: "Connect one or more CommandCode reverse-proxy accounts for routed task execution.",
    descriptionTraditionalChinese: "連接一個或多個 CommandCode 反向代理帳戶，用作任務路由執行。",
    aliases: ["commandcode", "command code proxy", "reverse proxy"],
  },
  openrouter: {
    english: "OpenRouter",
    traditionalChinese: "OpenRouter",
    descriptionEnglish: "Route approved models through an OpenRouter API account.",
    descriptionTraditionalChinese: "透過 OpenRouter API 帳戶路由已批准模型。",
    aliases: ["open router", "api key"],
  },
  ollama: {
    english: "Ollama",
    traditionalChinese: "Ollama",
    descriptionEnglish: "Use a local Ollama endpoint with account-level model routing.",
    descriptionTraditionalChinese: "使用本機 Ollama endpoint，並套用帳戶級模型路由。",
    aliases: ["local llm", "ollama local"],
  },
  "custom-openai-compatible": {
    english: "Custom OpenAI Compatible",
    traditionalChinese: "自訂 OpenAI-Compatible",
    descriptionEnglish: "Register another OpenAI-compatible endpoint as a managed provider.",
    descriptionTraditionalChinese: "將其他 OpenAI-compatible endpoint 註冊為受管理供應商。",
    aliases: ["custom endpoint", "openai compatible", "custom api"],
  },
};

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

function supportsProviderLogin(provider: ProviderDefinition): boolean {
  return provider.auth === "oauth"
    || provider.auth === "browser_session"
    || provider.loginMode === "antigravity_management"
    || provider.loginMode === "commandcode_oauth";
}

function presentation(provider: ProviderDefinition): ProviderPresentation {
  return PROVIDER_PRESENTATION[provider.id] ?? {
    english: provider.name,
    traditionalChinese: provider.name,
    descriptionEnglish: "Manage accounts, models, health and routing for this provider.",
    descriptionTraditionalChinese: "管理此供應商的帳戶、模型、健康狀態與路由。",
    aliases: [],
  };
}

function providerName(language: Language, provider: ProviderDefinition): string {
  const value = presentation(provider);
  return text(language, value.english, value.traditionalChinese);
}

function providerDescription(language: Language, provider: ProviderDefinition): string {
  const value = presentation(provider);
  return text(language, value.descriptionEnglish, value.descriptionTraditionalChinese);
}

function providerGlyph(provider: ProviderDefinition): string {
  const words = providerName("en", provider).split(/\s+/u).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "AI";
}

function categoryLabel(language: Language, category: ProviderCategoryFilter): string {
  const labels: Record<ProviderCategoryFilter, [string, string]> = {
    all: ["All providers", "所有供應商"],
    oauth: ["OAuth", "OAuth"],
    api_key: ["API key", "API Key"],
    browser: ["Browser", "瀏覽器"],
    reverse_proxy: ["Reverse proxy", "反向代理"],
    custom: ["Local / custom", "本機／自訂"],
  };
  const [english, traditionalChinese] = labels[category];
  return text(language, english, traditionalChinese);
}

function authLabel(language: Language, auth: ProviderAuth): string {
  const labels: Record<ProviderAuth, [string, string]> = {
    oauth: ["OAuth", "OAuth"],
    api_key: ["API key", "API Key"],
    browser_session: ["Browser session", "瀏覽器 Session"],
    local_proxy: ["Local proxy", "本機代理"],
  };
  const [english, traditionalChinese] = labels[auth];
  return text(language, english, traditionalChinese);
}

function statusLabel(language: Language, status: ProviderAccountStatus): string {
  const labels: Record<ProviderAccountStatus, [string, string]> = {
    pending: ["Pending", "等待中"],
    connected: ["Connected", "已連線"],
    expired: ["Expired", "已過期"],
    error: ["Error", "錯誤"],
    disabled: ["Disabled", "已停用"],
  };
  const [english, traditionalChinese] = labels[status];
  return text(language, english, traditionalChinese);
}

function capabilityLabel(language: Language, capability: ProviderDefinition["capabilities"][number]): string {
  const labels: Record<ProviderDefinition["capabilities"][number], [string, string]> = {
    text: ["Text", "文字"],
    reasoning: ["Reasoning", "推理"],
    tools: ["Tools", "工具"],
    vision: ["Vision", "視覺"],
    image_generation: ["Images", "圖像"],
  };
  const [english, traditionalChinese] = labels[capability];
  return text(language, english, traditionalChinese);
}

function emptyDraft(providerId = PROVIDER_CATALOG[0].id): AccountDraft {
  const provider = providerDefinition(providerId);
  return {
    providerId: provider.id,
    label: provider.name,
    identity: "",
    endpoint: provider.baseUrl ?? "",
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
    endpoint: account.endpoint ?? providerDefinition(account.providerId).baseUrl ?? "",
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

function providerAccountCounts(
  accounts: readonly ProviderAccountRecord[],
  providerId: string,
): { accounts: number; models: number; connected: number } {
  const providerAccounts = accounts.filter((account) => account.providerId === providerId);
  return {
    accounts: providerAccounts.length,
    models: new Set(providerAccounts.flatMap((account) => account.models)).size,
    connected: providerAccounts.filter((account) => (
      account.enabled && account.status === "connected"
    )).length,
  };
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function ProviderCenterSurface({ language, setError }: SurfaceProps) {
  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot>(EMPTY_SNAPSHOT);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerCategory, setProviderCategory] = useState<ProviderCategoryFilter>("all");
  const [selectedProviderId, setSelectedProviderId] = useState(PROVIDER_CATALOG[0].id);
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const activeAccounts = useMemo(
    () => snapshot.accounts.filter((account) => !account.archivedAt),
    [snapshot],
  );
  const selectedProvider = providerDefinition(selectedProviderId);
  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
  const selectedProviderAccounts = useMemo(() => activeAccounts
    .filter((account) => account.providerId === selectedProviderId)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      const leftConnected = left.enabled && left.status === "connected";
      const rightConnected = right.enabled && right.status === "connected";
      if (leftConnected !== rightConnected) return leftConnected ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    }), [activeAccounts, selectedProviderId]);

  const connectedAccounts = useMemo(
    () => activeAccounts.filter((account) => account.enabled && account.status === "connected"),
    [activeAccounts],
  );

  const accountValidation = useMemo(() => {
    if (!draft.providerId) return text(language, "Choose a provider.", "請選擇供應商。");
    if (!draft.label.trim()) return text(language, "Account label is required.", "必須填寫帳戶名稱。");
    if (draft.endpoint.trim()) {
      try {
        const endpoint = new URL(draft.endpoint.trim());
        const loopback = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
          || endpoint.hostname.startsWith("127.");
        if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
          return text(
            language,
            "Provider endpoint requires HTTPS; HTTP is only allowed on loopback.",
            "供應商端點必須使用 HTTPS；HTTP 只允許本機 Loopback。",
          );
        }
      } catch {
        return text(language, "Provider endpoint is invalid.", "供應商端點無效。");
      }
    }
    return "";
  }, [draft.endpoint, draft.label, draft.providerId, language]);

  const routingRequirements = useMemo(() => {
    if (!selectedAccount) return text(language, "Save an account before configuring task routing.", "請先儲存帳戶，再設定任務路由。");
    if (!workspaceId) return text(language, "Choose a workspace to configure routing.", "請選擇工作區以設定路由。");
    if (!selectedAccount.enabled || selectedAccount.status !== "connected") {
      return text(language, "The account must be enabled and connected before routing.", "帳戶必須已啟用並已連線，先可以設定路由。");
    }
    if (!(selectedModel.trim() || selectedAccount.models[0])) {
      return text(language, "Choose or enter a task model.", "請選擇或輸入任務模型。");
    }
    if (workload === "anneal" && (!projectId.trim() || !repoId.trim() || !assigneeId.trim())) {
      return text(
        language,
        "Anneal routing requires project, repository and assigned-agent IDs.",
        "Anneal 路由需要專案、儲存庫及獲指派代理 ID。",
      );
    }
    return "";
  }, [assigneeId, language, projectId, repoId, selectedAccount, selectedModel, workload, workspaceId]);

  const filteredProviders = useMemo(() => {
    const query = normalizeSearch(providerSearch);
    return PROVIDER_CATALOG.filter((provider) => {
      if (providerCategory !== "all" && provider.category !== providerCategory) return false;
      if (!query) return true;
      const providerAccounts = activeAccounts.filter((account) => account.providerId === provider.id);
      const info = presentation(provider);
      const haystack = [
        provider.id,
        provider.name,
        info.english,
        info.traditionalChinese,
        info.descriptionEnglish,
        info.descriptionTraditionalChinese,
        ...info.aliases,
        ...providerAccounts.flatMap((account) => [account.label, account.identity ?? ""]),
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    }).sort((left, right) => {
      const leftAccounts = activeAccounts.filter((account) => account.providerId === left.id);
      const rightAccounts = activeAccounts.filter((account) => account.providerId === right.id);
      const leftConnected = leftAccounts.filter((account) => account.enabled && account.status === "connected").length;
      const rightConnected = rightAccounts.filter((account) => account.enabled && account.status === "connected").length;
      if (leftConnected !== rightConnected) return rightConnected - leftConnected;
      if (leftAccounts.length !== rightAccounts.length) return rightAccounts.length - leftAccounts.length;
      if (left.priority !== right.priority) return right.priority - left.priority;
      return providerName(language, left).localeCompare(providerName(language, right));
    });
  }, [activeAccounts, language, providerCategory, providerSearch]);

  const adoptSnapshot = useCallback((next: ProviderNetworkSnapshot, preferredId?: string) => {
    setSnapshot(next);
    const currentId = preferredId ?? selectedAccountId;
    const selected = next.accounts.find((account) => account.id === currentId && !account.archivedAt)
      ?? next.accounts.find((account) => account.isDefault && !account.archivedAt)
      ?? next.accounts.find((account) => !account.archivedAt);
    if (selected) {
      setSelectedProviderId(selected.providerId);
      setSelectedAccountId(selected.id);
      setDraft(accountDraft(selected));
      setSelectedModel((current) => current || selected.models[0] || "");
      setSecret("");
      return;
    }
    setSelectedAccountId("");
    setDraft(emptyDraft(selectedProviderId));
    setSelectedModel("");
    setSecret("");
  }, [selectedAccountId, selectedProviderId]);

  const refreshProviderHub = useCallback(async () => {
    const api = window.codexWebLauncher;
    if (!api) throw new Error(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商樞紐。"));
    const next = await api.providerSnapshot();
    adoptSnapshot(next);
    return next;
  }, [adoptSnapshot, language]);

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
      setError(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商樞紐。"));
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
  }, [adoptSnapshot, language, setError]);

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

  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId);
    setEditorOpen(false);
    setNotice("");
    const accounts = activeAccounts.filter((account) => account.providerId === providerId);
    const account = accounts.find((candidate) => candidate.isDefault) ?? accounts[0];
    if (account) {
      setSelectedAccountId(account.id);
      setDraft(accountDraft(account));
      setSelectedModel(account.models[0] ?? "");
    } else {
      setSelectedAccountId("");
      setDraft(emptyDraft(providerId));
      setSelectedModel(providerDefinition(providerId).models[0] ?? "");
    }
    setSecret("");
  };

  const selectAccount = (account: ProviderAccountRecord) => {
    setSelectedProviderId(account.providerId);
    setSelectedAccountId(account.id);
    setDraft(accountDraft(account));
    setSelectedModel(account.models[0] ?? "");
    setSecret("");
    setEditorOpen(true);
    setNotice("");
  };

  const startNewAccount = (providerId = selectedProviderId) => {
    const provider = providerDefinition(providerId);
    setSelectedProviderId(provider.id);
    setSelectedAccountId("");
    setDraft(emptyDraft(provider.id));
    setSecret("");
    setSelectedModel(provider.models[0] ?? "");
    setEditorOpen(true);
    setNotice("");
  };

  const persistAccount = async (): Promise<ProviderAccountRecord> => {
    const api = window.codexWebLauncher;
    if (!api) throw new Error(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商樞紐。"));
    if (accountValidation) throw new Error(accountValidation);
    const models = parseModels(draft.modelsText);
    const provider = providerDefinition(draft.providerId);
    const requiresCredential = draft.auth === "api_key" || draft.auth === "local_proxy";
    const managedLogin = provider.loginMode === "antigravity_management"
      || provider.loginMode === "commandcode_oauth";
    const status = managedLogin
      ? (secret.trim() ? "connected" : draft.status)
      : requiresCredential && secret.trim() ? "connected" : draft.status;
    const input: ProviderAccountInput = {
      id: draft.id,
      providerId: draft.providerId,
      label: draft.label.trim(),
      identity: draft.identity.trim() || undefined,
      endpoint: draft.endpoint.trim() || undefined,
      auth: draft.auth,
      status,
      enabled: draft.enabled,
      isDefault: draft.isDefault,
      models,
      ...(secret.trim()
        ? {
            secret: provider.loginMode === "commandcode_oauth"
              ? {
                  apiKey: secret.trim(),
                  baseUrl: draft.endpoint.trim() || provider.baseUrl || "http://127.0.0.1:9090",
                }
              : { credential: secret.trim() },
          }
        : {}),
    };
    const next = await api.saveProviderAccount(input);
    const saved = newestMatchingAccount(next, input);
    if (!saved) throw new Error(text(
      language,
      "Provider Hub saved the account but did not return it.",
      "供應商樞紐已儲存帳戶，但未能傳回帳戶資料。",
    ));
    adoptSnapshot(next, saved.id);
    setSelectedProviderId(saved.providerId);
    setSelectedAccountId(saved.id);
    setDraft(accountDraft(saved));
    setSecret("");
    setSelectedModel((current) => current || saved.models[0] || "");
    setEditorOpen(true);
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
      const result = await api.beginProviderLogin(saved.id);
      if (result.snapshot) adoptSnapshot(result.snapshot, saved.id);
      setNotice(text(
        language,
        result.snapshot
          ? "The provider session is connected and its model catalogue was refreshed."
          : "The login page opened. Complete the provider sign-in to continue.",
        result.snapshot
          ? "供應商工作階段已連線，模型清單亦已更新。"
          : "登入頁面已開啟。請完成供應商登入以繼續。",
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const importCommandCodeSession = async () => {
    const api = window.codexWebLauncher;
    if (!api) return;
    setBusy("provider-import");
    setError(null);
    try {
      const saved = selectedAccount ?? await persistAccount();
      const next = await api.importProviderSession(saved.id);
      adoptSnapshot(next, saved.id);
      setNotice(text(
        language,
        "CommandCode CLI session imported; identity and models were refreshed.",
        "已匯入 CommandCode CLI 工作階段；身份及模型清單已更新。",
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const testProviderConnection = async () => {
    const api = window.codexWebLauncher;
    if (!api || !selectedAccount) return;
    setBusy("provider-probe");
    setError(null);
    try {
      const next = await api.probeProviderAccount(selectedAccount.id);
      adoptSnapshot(next, selectedAccount.id);
      const probed = next.accounts.find((account) => account.id === selectedAccount.id);
      setNotice(probed?.status === "connected"
        ? text(language, "Connection succeeded and models were refreshed.", "連線成功，模型清單已更新。")
        : text(language, "Provider session is not connected yet.", "供應商工作階段尚未連線。"));
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
      setSnapshot(next);
      setSelectedAccountId("");
      setDraft(emptyDraft(selectedProviderId));
      setSelectedModel("");
      setSecret("");
      setEditorOpen(false);
      setNotice(text(language, "Account archived; retained data was not deleted.", "帳戶已封存；保留資料並未刪除。"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectProvider = async () => {
    const launcher = window.codexWebLauncher;
    const api = window.codingTools;
    if (!launcher || !api) throw new Error(text(language, "The execution bridge is unavailable.", "執行橋接目前無法使用。"));
    if (!selectedAccount) throw new Error(text(language, "Save and select an account first.", "請先儲存並選擇帳戶。"));
    if (!workspaceId) throw new Error(text(language, "Select a workspace first.", "請先選擇工作區。"));
    if (!selectedAccount.enabled || selectedAccount.status !== "connected") {
      throw new Error(text(language, "The selected account must be enabled and connected.", "所選帳戶必須已啟用並已連線。"));
    }
    const model = selectedModel.trim() || selectedAccount.models[0] || "";
    if (!model) throw new Error(text(language, "Select or enter a task model.", "請選擇或輸入任務模型。"));
    if (workload === "anneal" && (!projectId.trim() || !repoId.trim() || !assigneeId.trim())) {
      throw new Error(text(
        language,
        "Anneal requires project, repository and assigned agent IDs.",
        "Anneal 需要專案、儲存庫與獲指派代理 ID。",
      ));
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
    <section className="provider-surface provider-console">
      <header className="provider-console-header">
        <div className="provider-console-title">
          <span className="provider-console-kicker">{text(language, "CONNECTION CONTROL", "連線控制")}</span>
          <h1>{text(language, "Provider Hub", "供應商樞紐")}</h1>
          <p>{text(
            language,
            "Search every provider, manage multiple accounts, then route one approved account into Paseo or Anneal.",
            "搜尋所有供應商、管理多個帳戶，再將一個已批准帳戶路由至 Paseo 或 Anneal。",
          )}</p>
        </div>
        <div className="provider-console-metrics" aria-label={text(language, "Provider Hub summary", "供應商樞紐摘要")}>
          <article><strong>{PROVIDER_CATALOG.length}</strong><span>{text(language, "Providers", "供應商")}</span></article>
          <article><strong>{activeAccounts.length}</strong><span>{text(language, "Accounts", "帳戶")}</span></article>
          <article><strong>{connectedAccounts.length}</strong><span>{text(language, "Connected", "已連線")}</span></article>
          <article><strong>{snapshot.proxyProfiles.filter((profile) => !profile.archivedAt).length}</strong><span>{text(language, "Proxy profiles", "代理設定檔")}</span></article>
        </div>
      </header>

      <div className="provider-console-toolbar">
        <label className="provider-workspace-field">
          <span>{text(language, "Workspace", "工作區")}</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">{text(language, "Select workspace", "選擇工作區")}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.label}</option>
            ))}
          </select>
        </label>
        <div className="provider-toolbar-actions">
          <span className={`provider-global-route${snapshot.routing.globalEnabled ? " is-enabled" : ""}`}>
            {snapshot.routing.globalEnabled
              ? text(language, "Global proxy enabled", "已啟用全域代理")
              : text(language, "Direct / inherited routing", "直接／繼承路由")}
          </span>
          <button className="provider-secondary-button" onClick={() => void refreshProviderHub().catch((cause) => setError(messageOf(cause)))} type="button">
            {text(language, "Refresh accounts", "刷新帳戶")}
          </button>
          <button className="provider-secondary-button" onClick={() => void refreshBindings().catch((cause) => setError(messageOf(cause)))} type="button">
            {text(language, "Refresh routing", "刷新路由")}
          </button>
          <button className="provider-primary-button" onClick={() => startNewAccount()} type="button">
            + {text(language, "Add account", "新增帳戶")}
          </button>
        </div>
      </div>

      {notice ? <p className="provider-notice" role="status">{notice}</p> : null}

      <div className="provider-console-layout">
        <aside className="provider-directory-panel">
          <div className="provider-directory-heading">
            <div>
              <strong>{text(language, "Provider directory", "供應商目錄")}</strong>
              <span>{text(language, "All integrations remain visible even before an account is added.", "即使未新增帳戶，所有整合仍然可見。")}</span>
            </div>
          </div>

          <label className="provider-directory-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label={text(language, "Search providers or accounts", "搜尋供應商或帳戶")}
              onChange={(event) => setProviderSearch(event.target.value)}
              placeholder={text(language, "Search providers or accounts", "搜尋供應商或帳戶")}
              type="search"
              value={providerSearch}
            />
          </label>

          <div className="provider-filter-chips" role="tablist" aria-label={text(language, "Provider categories", "供應商分類")}>
            {PROVIDER_FILTERS.map((filter) => (
              <button
                aria-selected={providerCategory === filter}
                className={`provider-filter-chip${providerCategory === filter ? " is-active" : ""}`}
                key={filter}
                onClick={() => setProviderCategory(filter)}
                role="tab"
                type="button"
              >
                {categoryLabel(language, filter)}
              </button>
            ))}
          </div>

          <div className="provider-directory-list">
            {filteredProviders.map((provider) => {
              const counts = providerAccountCounts(activeAccounts, provider.id);
              const selected = selectedProviderId === provider.id;
              return (
                <button
                  className={`provider-directory-row${selected ? " is-selected" : ""}`}
                  key={provider.id}
                  onClick={() => selectProvider(provider.id)}
                  type="button"
                >
                  <span className="provider-directory-avatar">{providerGlyph(provider)}</span>
                  <span className="provider-directory-copy">
                    <strong>{providerName(language, provider)}</strong>
                    <small>{categoryLabel(language, provider.category)} · {authLabel(language, provider.auth)}</small>
                  </span>
                  <span
                  className="provider-directory-counts"
                  data-provider-account-summary={`${counts.accounts}:${counts.models}:${counts.connected}`}
                >
                    <strong>{counts.accounts}</strong>
                    <small>{counts.connected > 0
                      ? text(language, `${counts.connected} active`, `${counts.connected} 個啟用中`)
                      : text(language, "No account", "未有帳戶")}</small>
                  </span>
                </button>
              );
            })}
            {filteredProviders.length === 0 ? (
              <div className="provider-directory-empty">
                <strong>{text(language, "No matching provider", "找不到相符的供應商")}</strong>
                <span>{text(language, "Try another search or category.", "請嘗試其他搜尋字詞或分類。")}</span>
              </div>
            ) : null}
          </div>
        </aside>

        <main className="provider-detail-panel">
          <header className="provider-detail-header">
            <span className="provider-detail-avatar">{providerGlyph(selectedProvider)}</span>
            <div className="provider-detail-copy">
              <div className="provider-detail-title-row">
                <h2>{providerName(language, selectedProvider)}</h2>
                <span>{selectedProviderAccounts.length} {text(language, "accounts", "個帳戶")}</span>
              </div>
              <p>{providerDescription(language, selectedProvider)}</p>
              <div className="provider-detail-badges">
                <span>{categoryLabel(language, selectedProvider.category)}</span>
                <span>{authLabel(language, selectedProvider.auth)}</span>
                <span>{selectedProvider.protocol.replaceAll("_", " ")}</span>
                {selectedProvider.capabilities.map((capability) => (
                  <span key={capability}>{capabilityLabel(language, capability)}</span>
                ))}
              </div>
            </div>
            <button className="provider-primary-button" onClick={() => startNewAccount(selectedProvider.id)} type="button">
              + {text(language, "Add account", "新增帳戶")}
            </button>
          </header>

          <section className="provider-account-section">
            <div className="provider-section-heading">
              <div>
                <h3>{text(language, "Accounts and routing", "帳戶與路由")}</h3>
                <p>{text(language, "Select an account to edit credentials, health and task routing.", "選擇帳戶以編輯憑證、健康狀態與任務路由。")}</p>
              </div>
            </div>

            <div className="provider-account-list">
              {selectedProviderAccounts.map((account) => {
                const connected = account.enabled && account.status === "connected";
                return (
                  <button
                    className={`provider-account-row${account.id === selectedAccountId ? " is-selected" : ""}`}
                    key={account.id}
                    onClick={() => selectAccount(account)}
                    type="button"
                  >
                    <span className={`provider-account-status${connected ? " is-connected" : ""}`} aria-hidden="true" />
                    <span className="provider-account-copy">
                      <strong>{account.label}</strong>
                      <small>{account.identity || authLabel(language, account.auth)}</small>
                    </span>
                    <span className="provider-account-tags">
                      {account.isDefault ? <em>{text(language, "Default", "預設")}</em> : null}
                      {account.hasCredential ? <em>{text(language, "Credential stored", "已儲存憑證")}</em> : null}
                    </span>
                    <span className="provider-account-health">
                      <strong>{statusLabel(language, account.status)}</strong>
                      <small>{account.models.length} {text(language, "models", "個模型")}</small>
                    </span>
                  </button>
                );
              })}

              {selectedProviderAccounts.length === 0 ? (
                <div className="provider-account-empty">
                  <div>
                    <strong>{text(language, "No account added yet", "尚未新增帳戶")}</strong>
                    <span>{text(
                      language,
                      "This provider is integrated and ready. Add the first account to configure login or credentials.",
                      "此供應商已完成整合並可供使用。新增第一個帳戶以設定登入或憑證。",
                    )}</span>
                  </div>
                  <button className="provider-secondary-button" onClick={() => startNewAccount(selectedProvider.id)} type="button">
                    + {text(language, "Add first account", "新增第一個帳戶")}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          {editorOpen ? (
            <section className="provider-editor-card">
              <header className="provider-editor-card-header">
                <div>
                  <span>{draft.id ? text(language, "MANAGE ACCOUNT", "管理帳戶") : text(language, "NEW ACCOUNT", "新增帳戶")}</span>
                  <h3>{draft.id ? draft.label : providerName(language, selectedProvider)}</h3>
                </div>
                <button
                  aria-label={text(language, "Close account editor", "關閉帳戶編輯器")}
                  className="provider-icon-button"
                  onClick={() => setEditorOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </header>

              <div className="provider-editor-grid">
                <label>
                  <span>{text(language, "Provider", "供應商")}</span>
                  <select
                    disabled={Boolean(draft.id)}
                    onChange={(event) => {
                      const provider = providerDefinition(event.target.value);
                      setSelectedProviderId(provider.id);
                      setDraft((current) => ({
                        ...current,
                        providerId: provider.id,
                        auth: provider.auth,
                        label: provider.name,
                        endpoint: provider.baseUrl ?? "",
                        modelsText: provider.models.join("\n"),
                      }));
                      setSelectedModel(provider.models[0] ?? "");
                    }}
                    value={draft.providerId}
                  >
                    {PROVIDER_CATALOG.map((provider) => (
                      <option key={provider.id} value={provider.id}>{providerName(language, provider)}</option>
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
                    {AUTH_TYPES.map((auth) => <option key={auth} value={auth}>{authLabel(language, auth)}</option>)}
                  </select>
                </label>
                <label>
                  <span>{text(language, "Connection status", "連線狀態")}</span>
                  <select value={draft.status} onChange={(event) => setDraft((current) => ({
                    ...current,
                    status: event.target.value as ProviderAccountStatus,
                  }))}>
                    {ACCOUNT_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(language, status)}</option>)}
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
                <label className="provider-full-row">
                  <span>{text(language, "Account model catalogue (comma or line separated)", "帳戶模型清單（逗號或逐行分隔）")}</span>
                  <textarea
                    rows={3}
                    value={draft.modelsText}
                    onChange={(event) => setDraft((current) => ({ ...current, modelsText: event.target.value }))}
                  />
                </label>
                <label className="provider-full-row">
                  <span>{text(language, "Provider / management endpoint", "供應商／管理端點")}</span>
                  <input
                    placeholder={selectedProvider.baseUrl ?? "https://…"}
                    value={draft.endpoint}
                    onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
                  />
                </label>
                <label className="provider-full-row">
                  <span>{selectedProvider.loginMode === "antigravity_management"
                    ? text(language, "CLIProxyAPI management key (encrypted by Electron main process)", "CLIProxyAPI 管理金鑰（由 Electron 主程序加密）")
                    : selectedProvider.loginMode === "commandcode_oauth"
                      ? text(language, "CommandCode API key (or use login/import below)", "CommandCode API Key（或使用下方登入／匯入）")
                      : text(language, "Credential (encrypted by Electron main process)", "憑證（由 Electron 主程序加密）")}</span>
                  <input
                    autoComplete="off"
                    placeholder={selectedAccount?.hasCredential
                      ? text(language, "Stored — leave blank to keep it", "已儲存——留空即可保留")
                      : text(language, "Enter API key, token or local-proxy credential", "輸入 API Key、Token 或本機代理憑證")}
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <label className="provider-check-row">
                  <input
                    checked={draft.enabled}
                    onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                    type="checkbox"
                  />
                  <span>{text(language, "Account enabled", "啟用帳戶")}</span>
                </label>
                <label className="provider-check-row">
                  <input
                    checked={draft.isDefault}
                    onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))}
                    type="checkbox"
                  />
                  <span>{text(language, "Default for this provider", "此供應商預設帳戶")}</span>
                </label>
              </div>

              {accountValidation ? (
                <p className="provider-account-inline-error" role="alert">{accountValidation}</p>
              ) : null}

              <div className="provider-editor-actions">
                <div>
                  {selectedAccount ? (
                    <>
                      <button className="provider-secondary-button" disabled={busy !== null || selectedAccount.isDefault} onClick={() => void setDefaultAccount()} type="button">
                        {text(language, "Set default", "設為預設")}
                      </button>
                      <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void toggleAccountEnabled()} type="button">
                        {selectedAccount.enabled ? text(language, "Disable", "停用") : text(language, "Enable", "啟用")}
                      </button>
                      <button className="provider-danger-button" disabled={busy !== null} onClick={() => void archiveAccount()} type="button">
                        {text(language, "Archive", "封存")}
                      </button>
                    </>
                  ) : null}
                </div>
                <div>
                  {selectedAccount && ["antigravity_management", "commandcode_oauth"].includes(selectedProvider.loginMode ?? "") ? (
                    <button className="provider-secondary-button" disabled={busy !== null} onClick={() => void testProviderConnection()} type="button">
                      {busy === "provider-probe" ? "…" : text(language, "Test reverse proxy", "測試反向代理")}
                    </button>
                  ) : null}
                  {selectedProvider.loginMode === "commandcode_oauth" ? (
                    <button className="provider-secondary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void importCommandCodeSession()} type="button">
                      {busy === "provider-import"
                        ? "…"
                        : text(language, "Import CommandCode CLI session", "匯入 CommandCode CLI 工作階段")}
                    </button>
                  ) : null}
                  {supportsProviderLogin(selectedProvider) ? (
                    <button className="provider-secondary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void openLogin()} type="button">
                      {busy === "provider-login"
                        ? "…"
                        : selectedProvider.loginMode === "commandcode_oauth"
                          ? text(language, "Login with CommandCode", "使用 CommandCode 登入")
                          : selectedAccount?.status === "connected" || selectedAccount?.status === "expired"
                            ? text(language, "Refresh session", "更新工作階段")
                            : text(language, "Login account", "登入帳戶")}
                    </button>
                  ) : null}
                  <button className="provider-primary-button" disabled={busy !== null || Boolean(accountValidation)} onClick={() => void saveAccount()} type="button">
                    {busy === "save-account" ? "…" : text(language, "Save account", "儲存帳戶")}
                  </button>
                </div>
              </div>

              {selectedAccount ? (
                <details className="provider-routing-panel">
                  <summary>
                    <span>
                      <strong>{text(language, "Paseo / Anneal task routing", "Paseo／Anneal 任務路由")}</strong>
                      <small>{text(language, "Advanced execution settings", "進階執行設定")}</small>
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </summary>
                  <div className="provider-editor-grid provider-routing-grid">
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
                    <label className="provider-check-row">
                      <input
                        checked={allowProviderFallback}
                        onChange={(event) => setAllowProviderFallback(event.target.checked)}
                        type="checkbox"
                      />
                      <span>{text(language, "Allow healthy-account fallback", "允許健康帳戶後備路由")}</span>
                    </label>
                    {workload === "anneal" ? (
                      <>
                        <label><span>{text(language, "Anneal project ID", "Anneal 專案 ID")}</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
                        <label><span>{text(language, "Anneal repository ID", "Anneal 儲存庫 ID")}</span><input value={repoId} onChange={(event) => setRepoId(event.target.value)} /></label>
                        <label className="provider-full-row"><span>{text(language, "Anneal assigned agent ID", "Anneal 獲指派代理 ID")}</span><input value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} /></label>
                      </>
                    ) : null}
                  </div>
                  {routingRequirements ? (
                    <p className="provider-account-inline-error" role="status">{routingRequirements}</p>
                  ) : null}
                  <div className="provider-routing-actions">
                    <button
                      className="provider-primary-button"
                      disabled={busy !== null || Boolean(routingRequirements)}
                      onClick={() => void connectProvider()}
                      type="button"
                    >
                      {busy === "connect-provider" ? "…" : text(language, "Connect selected account", "連接所選帳戶")}
                    </button>
                  </div>
                </details>
              ) : null}
            </section>
          ) : null}

          <section className="provider-binding-section">
            <div className="provider-section-heading">
              <div>
                <h3>{text(language, "Approved task bindings", "已批准任務綁定")}</h3>
                <p>{text(language, "Current Paseo and Anneal bindings for the selected workspace.", "所選工作區目前的 Paseo 與 Anneal 綁定。")}</p>
              </div>
            </div>
            <div className="provider-binding-list">
              {bindings.map((binding) => (
                <article key={binding.id}>
                  <span className={`provider-account-status${connectedBindingIds.has(binding.id) ? " is-connected" : ""}`} />
                  <div>
                    <strong>{binding.provider ?? binding.id} · {binding.model ?? "—"}</strong>
                    <small>{binding.engine ?? "—"} · {binding.endpoint ?? "—"}</small>
                  </div>
                  <em>{connectedBindingIds.has(binding.id)
                    ? text(language, "Connected", "已連線")
                    : text(language, "Pending", "等待中")}</em>
                </article>
              ))}
              {bindings.length === 0 ? (
                <div className="provider-binding-empty">
                  {text(language, "No approved binding in this workspace yet.", "此工作區目前未有已批准綁定。")}
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </section>
  );
}
