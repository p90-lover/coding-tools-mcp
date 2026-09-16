import { useEffect, useMemo, useState } from "react";
import type { Language } from "../types";
import {
  DEFAULT_PROVIDERS,
  type ProviderDefinition,
} from "../providers/provider-types";
import type {
  CustomOrchestratorDefinition,
  OrchestrationStage,
} from "../orchestration/paseo-anneal-types";
import "./provider-orchestrator.css";

interface SurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
}

interface WorkspaceOption {
  id: string;
  label: string;
}

interface ProviderInstance {
  id: string;
  definitionId: string;
  name: string;
  baseUrl: string;
  models: string[];
  selectedModel: string;
  engine: "paseo" | "anneal";
  engineEndpoint: string;
  mode: string;
  projectId: string;
  repoId: string;
  assigneeId: string;
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

const PROVIDER_STORAGE_KEY = "coding-tools-provider-instances-v1";
const ORCHESTRATOR_STORAGE_KEY = "coding-tools-orchestrators-v1";

function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function presetBaseUrl(providerId: string): string {
  switch (providerId) {
    case "commandcode-proxy":
      return "http://127.0.0.1:3050/v1/";
    case "ai-studio-reverse-proxy":
      return "http://127.0.0.1:7860/v1beta/";
    case "gemini-reverse-proxy":
      return "http://127.0.0.1:8317/v1beta/";
    case "aistudio-to-api":
      return "http://127.0.0.1:7860/v1/";
    case "cliproxyapi-antigravity":
      return "http://127.0.0.1:8317/v1/";
    default:
      return "";
  }
}

function defaultInstances(): ProviderInstance[] {
  return DEFAULT_PROVIDERS.map((provider) => ({
    id: provider.id,
    definitionId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl ?? presetBaseUrl(provider.id),
    models: [...provider.models],
    selectedModel: provider.models[0] ?? "",
    engine: "anneal",
    engineEndpoint: "http://127.0.0.1:3000/",
    mode: "default",
    projectId: "",
    repoId: "",
    assigneeId: "",
  }));
}

function loadProviderInstances(): ProviderInstance[] {
  try {
    const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!stored) return defaultInstances();
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return defaultInstances();
    const instances = parsed.filter((value): value is ProviderInstance => {
      if (!value || typeof value !== "object") return false;
      const row = value as Record<string, unknown>;
      return typeof row.id === "string"
        && typeof row.definitionId === "string"
        && typeof row.name === "string"
        && typeof row.baseUrl === "string";
    });
    return instances.length > 0 ? instances : defaultInstances();
  } catch {
    return defaultInstances();
  }
}

function saveProviderInstances(instances: ProviderInstance[]): void {
  localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(instances));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function workspaceOptions(value: unknown): WorkspaceOption[] {
  const root = object(value);
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.workspaces)
        ? root.workspaces
        : Array.isArray(root?.data)
          ? root.data
          : [];
  return candidates.flatMap((candidate) => {
    const row = object(candidate);
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id) return [];
    const name = typeof row?.name === "string" ? row.name : id;
    const path = typeof row?.path === "string" ? row.path : "";
    return [{ id, label: path ? `${name} · ${path}` : name }];
  });
}

function executionRoot(value: unknown): Record<string, unknown> {
  const root = object(value) ?? {};
  return object(root.execution) ?? root;
}

function executionRevision(value: unknown): number {
  const root = executionRoot(value);
  return typeof root.revision === "number" ? root.revision : 0;
}

function boardRevision(value: unknown): number {
  const root = object(value) ?? {};
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

function missionRevision(value: unknown, missionId: string): number {
  const root = executionRoot(value);
  if (!Array.isArray(root.missions)) return 0;
  for (const candidate of root.missions) {
    const row = object(candidate);
    const mission = object(row?.mission);
    const spec = object(mission?.spec);
    if (spec?.mission_id === missionId && typeof mission?.revision === "number") {
      return mission.revision;
    }
  }
  return 0;
}

function providerDefinition(id: string): ProviderDefinition | undefined {
  return DEFAULT_PROVIDERS.find((provider) => provider.id === id);
}

function modelEndpoint(instance: ProviderInstance): string {
  const provider = providerDefinition(instance.definitionId);
  if (provider?.modelsEndpoint) return provider.modelsEndpoint;
  return "models";
}

function parseModels(value: unknown): string[] {
  const root = object(value);
  const candidates = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(value)
        ? value
        : [];
  const models = candidates.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    const row = object(candidate);
    const id = typeof row?.id === "string"
      ? row.id
      : typeof row?.name === "string"
        ? row.name.replace(/^models\//, "")
        : "";
    return id ? [id] : [];
  });
  return [...new Set(models)];
}

function duplicateInstance(source: ProviderInstance): ProviderInstance {
  return {
    ...source,
    id: `${source.definitionId}-${crypto.randomUUID().slice(0, 8)}`,
    name: `${source.name} Copy`,
    models: [...source.models],
  };
}

export function ProviderCenterSurface({ language, setError }: SurfaceProps) {
  const [instances, setInstances] = useState<ProviderInstance[]>(loadProviderInstances);
  const [selectedId, setSelectedId] = useState(instances[0]?.id ?? "");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [bindings, setBindings] = useState<ExecutionBinding[]>([]);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const selected = instances.find((instance) => instance.id === selectedId) ?? instances[0];
  const selectedDefinition = selected ? providerDefinition(selected.definitionId) : undefined;

  useEffect(() => saveProviderInstances(instances), [instances]);

  useEffect(() => {
    const api = window.codingTools;
    if (!api) return;
    void api.workspaces.list({}).then((value) => {
      const options = workspaceOptions(value);
      setWorkspaces(options);
      setWorkspaceId((current) => current || options[0]?.id || "");
    }).catch((cause) => setError(messageOf(cause)));
  }, [setError]);

  useEffect(() => {
    if (!workspaceId || !window.codingTools) return;
    void refreshBindings();
  }, [workspaceId]);

  const updateSelected = (patch: Partial<ProviderInstance>) => {
    if (!selected) return;
    setInstances((current) => current.map((instance) => (
      instance.id === selected.id ? { ...instance, ...patch } : instance
    )));
  };

  const refreshBindings = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId) return;
    const value = await api.execution.read({
      workspaceId,
      missionId: null,
      refreshSource: false,
    });
    setBindings(executionBindings(value));
  };

  const discoverModels = async () => {
    if (!selected) return;
    if (!selected.baseUrl.trim()) {
      setError(text(language, "This provider does not expose a model endpoint.", "此供應商未設定模型端點。"));
      return;
    }
    setBusy(`models:${selected.id}`);
    setError(null);
    try {
      const url = new URL(modelEndpoint(selected), selected.baseUrl.endsWith("/")
        ? selected.baseUrl
        : `${selected.baseUrl}/`);
      const headers = new Headers({ accept: "application/json" });
      if (credential.trim()) headers.set("authorization", `Bearer ${credential.trim()}`);
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
      const models = parseModels(await response.json());
      if (models.length === 0) throw new Error("The provider returned no model identifiers");
      updateSelected({ models, selectedModel: selected.selectedModel || models[0] });
      setNotice(text(language, `Discovered ${models.length} models.`, `已發現 ${models.length} 個模型。`));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectProvider = async () => {
    const api = window.codingTools;
    if (!api) throw new Error("Coding Tools execution bridge is unavailable");
    if (!selected || !selectedDefinition) return;
    if (!workspaceId) throw new Error("Select a workspace before connecting a provider");
    if (!selected.selectedModel.trim()) throw new Error("Select or enter a model");
    if (selected.engine === "anneal"
      && (!selected.projectId.trim() || !selected.repoId.trim() || !selected.assigneeId.trim())) {
      throw new Error("Anneal requires project, repository and assigned agent IDs");
    }
    setBusy(`connect:${selected.id}`);
    setError(null);
    try {
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
        settings: {
          id: selected.id,
          engine: selected.engine,
          endpoint: selected.engineEndpoint,
          provider: selected.definitionId,
          model: selected.selectedModel,
          mode: selected.mode || "default",
          projectId: selected.engine === "anneal" ? selected.projectId : null,
          repoId: selected.engine === "anneal" ? selected.repoId : null,
          assigneeId: selected.engine === "anneal" ? selected.assigneeId : null,
          maxDurationMin: 120,
          allowCodex: selected.definitionId === "codex-oauth",
          confirmExternalExecution: true,
        },
        credential,
        confirm: true,
      });
      setCredential("");
      await refreshBindings();
      setNotice(text(language, `${selected.name} is connected to ${selected.engine}.`, `${selected.name} 已連線至 ${selected.engine}。`));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const addProvider = () => {
    const source = selected ?? defaultInstances()[0];
    if (!source) return;
    const created = duplicateInstance(source);
    setInstances((current) => [...current, created]);
    setSelectedId(created.id);
  };

  const connectedIds = useMemo(() => new Set(bindings.filter((binding) => (
    binding.enabled && binding.connected && binding.current_scope_valid
  )).map((binding) => binding.id)), [bindings]);

  return (
    <section className="provider-surface">
      <header className="surface-heading provider-heading">
        <div>
          <span className="surface-kicker">PROVIDERS</span>
          <h1>{text(language, "Provider Center", "供應商中心")}</h1>
          <p>{text(
            language,
            "Manage API keys, OAuth accounts, ChatGPT Web, AI Studio and reverse proxies for Paseo and Anneal.",
            "管理 API Key、OAuth 帳戶、ChatGPT Web、AI Studio 及 Paseo／Anneal 反向代理。",
          )}</p>
        </div>
        <button className="primary-button compact" onClick={addProvider} type="button">
          + {text(language, "Add provider", "新增供應商")}
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
        <button className="secondary-button" onClick={() => void refreshBindings()} type="button">
          {text(language, "Refresh bindings", "刷新綁定")}
        </button>
        {notice ? <p className="inline-notice">{notice}</p> : null}
      </div>

      <div className="provider-layout">
        <div className="provider-card-grid">
          {instances.map((instance) => {
            const definition = providerDefinition(instance.definitionId);
            if (!definition) return null;
            const active = instance.id === selected?.id;
            const connected = connectedIds.has(instance.id);
            return (
              <button
                className={`provider-card${active ? " is-selected" : ""}`}
                key={instance.id}
                onClick={() => setSelectedId(instance.id)}
                type="button"
              >
                <div className="provider-card-title">
                  <span className="provider-avatar">{instance.name.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{instance.name}</strong>
                    <small>{definition.category.replaceAll("_", " ")} · {definition.auth.replaceAll("_", " ")}</small>
                  </div>
                  <i className={connected ? "status-dot is-connected" : "status-dot"} />
                </div>
                <div className="capability-row">
                  {definition.capabilities.map((capability) => (
                    <span key={capability}>{capability.replace("image_generation", "image")}</span>
                  ))}
                </div>
                <footer>
                  <span>{definition.paseoEnabled ? "Paseo" : ""}</span>
                  <span>{definition.annealEnabled ? "Anneal" : ""}</span>
                  <span>{instance.models.length} models</span>
                </footer>
              </button>
            );
          })}
        </div>

        {selected && selectedDefinition ? (
          <aside className="provider-editor">
            <div className="provider-editor-heading">
              <div>
                <span className="surface-kicker">{selectedDefinition.protocol.replaceAll("_", " ")}</span>
                <h2>{selected.name}</h2>
              </div>
              <span className={connectedIds.has(selected.id) ? "provider-state is-connected" : "provider-state"}>
                {connectedIds.has(selected.id)
                  ? text(language, "Connected", "已連線")
                  : text(language, "Available", "可使用")}
              </span>
            </div>

            <div className="editor-grid">
              <label>
                <span>{text(language, "Instance name", "實例名稱")}</span>
                <input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
              </label>
              <label>
                <span>{text(language, "Provider type", "供應商類型")}</span>
                <select value={selected.definitionId} onChange={(event) => {
                  const next = providerDefinition(event.target.value);
                  if (!next) return;
                  updateSelected({
                    definitionId: next.id,
                    name: next.name,
                    baseUrl: next.baseUrl ?? presetBaseUrl(next.id),
                    models: [...next.models],
                    selectedModel: next.models[0] ?? "",
                  });
                }}>
                  {DEFAULT_PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
              </label>
              <label className="full-row">
                <span>{text(language, "Provider base URL", "供應商 Base URL")}</span>
                <input
                  placeholder="http://127.0.0.1:7860/v1/"
                  value={selected.baseUrl}
                  onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                />
              </label>
              <label>
                <span>{text(language, "Engine", "引擎")}</span>
                <select value={selected.engine} onChange={(event) => {
                  const engine = event.target.value as ProviderInstance["engine"];
                  updateSelected({
                    engine,
                    engineEndpoint: engine === "paseo"
                      ? "ws://127.0.0.1:6767/ws"
                      : "http://127.0.0.1:3000/",
                  });
                }}>
                  <option value="paseo">Paseo</option>
                  <option value="anneal">Anneal</option>
                </select>
              </label>
              <label>
                <span>{text(language, "Engine endpoint", "引擎端點")}</span>
                <input value={selected.engineEndpoint} onChange={(event) => updateSelected({ engineEndpoint: event.target.value })} />
              </label>
              <label>
                <span>{text(language, "Model", "模型")}</span>
                <input
                  list={`models-${selected.id}`}
                  value={selected.selectedModel}
                  onChange={(event) => updateSelected({ selectedModel: event.target.value })}
                />
                <datalist id={`models-${selected.id}`}>
                  {selected.models.map((model) => <option key={model} value={model} />)}
                </datalist>
              </label>
              <label>
                <span>{text(language, "Mode", "模式")}</span>
                <input value={selected.mode} onChange={(event) => updateSelected({ mode: event.target.value })} />
              </label>
              {selected.engine === "anneal" ? (
                <>
                  <label><span>Anneal project ID</span><input value={selected.projectId} onChange={(event) => updateSelected({ projectId: event.target.value })} /></label>
                  <label><span>Anneal repository ID</span><input value={selected.repoId} onChange={(event) => updateSelected({ repoId: event.target.value })} /></label>
                  <label className="full-row"><span>Anneal assigned agent ID</span><input value={selected.assigneeId} onChange={(event) => updateSelected({ assigneeId: event.target.value })} /></label>
                </>
              ) : null}
              <label className="full-row">
                <span>{text(language, "Credential (RAM only)", "憑證（只存於記憶體）")}</span>
                <input
                  autoComplete="off"
                  type="password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </label>
            </div>

            <div className="provider-actions">
              <button
                className="secondary-button"
                disabled={busy !== null || !selected.baseUrl}
                onClick={() => void discoverModels()}
                type="button"
              >
                {busy === `models:${selected.id}` ? "…" : text(language, "Discover models", "發現模型")}
              </button>
              <button
                className="primary-button compact"
                disabled={busy !== null || !workspaceId}
                onClick={() => void connectProvider()}
                type="button"
              >
                {busy === `connect:${selected.id}` ? "…" : text(language, "Connect provider", "連接供應商")}
              </button>
            </div>

            <div className="binding-list">
              <h3>{text(language, "Approved bindings", "已批准綁定")}</h3>
              {bindings.length === 0 ? <p>{text(language, "No bindings in this workspace.", "此工作區未有綁定。")}</p> : null}
              {bindings.map((binding) => (
                <article key={binding.id}>
                  <div>
                    <strong>{binding.provider} / {binding.model}</strong>
                    <small>{binding.engine} · {binding.endpoint}</small>
                  </div>
                  <span>{binding.connected ? "connected" : "offline"}</span>
                </article>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function defaultOrchestrator(): CustomOrchestratorDefinition {
  const defaultProviders = DEFAULT_PROVIDERS.filter((provider) => provider.annealEnabled);
  const stageNames = ["Planner", "Coder", "Reviewer", "Tester"];
  return {
    id: `orchestrator-${crypto.randomUUID().slice(0, 8)}`,
    name: "Anneal delivery workflow",
    description: "Structured provider-aware delivery workflow",
    enabled: true,
    entryStageId: "planner",
    stages: stageNames.map((name, index) => ({
      id: name.toLowerCase(),
      name,
      model: {
        providerId: defaultProviders[index % Math.max(defaultProviders.length, 1)]?.id ?? "commandcode-proxy",
        model: "",
      },
      maxRetries: 2,
      approvalMode: "inherit",
      timeoutMs: 10 * 60 * 1000,
      completionRules: [index === stageNames.length - 1 ? "tests-pass" : "stage-complete"],
    })),
  };
}

function loadOrchestrators(): CustomOrchestratorDefinition[] {
  try {
    const stored = localStorage.getItem(ORCHESTRATOR_STORAGE_KEY);
    if (!stored) return [defaultOrchestrator()];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [defaultOrchestrator()];
    const profiles = parsed.filter((value): value is CustomOrchestratorDefinition => {
      const row = object(value);
      return typeof row?.id === "string" && typeof row?.name === "string" && Array.isArray(row?.stages);
    });
    return profiles.length > 0 ? profiles : [defaultOrchestrator()];
  } catch {
    return [defaultOrchestrator()];
  }
}

function saveOrchestrators(profiles: CustomOrchestratorDefinition[]): void {
  localStorage.setItem(ORCHESTRATOR_STORAGE_KEY, JSON.stringify(profiles));
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "stage";
}

function stageProvider(stage: OrchestrationStage): string {
  return stage.model?.providerId ?? "commandcode-proxy";
}

export function OrchestratorSurface({ language, setError }: SurfaceProps) {
  const [profiles, setProfiles] = useState<CustomOrchestratorDefinition[]>(loadOrchestrators);
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? "");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [confirmRun, setConfirmRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];

  useEffect(() => saveOrchestrators(profiles), [profiles]);

  useEffect(() => {
    const api = window.codingTools;
    if (!api) return;
    void api.workspaces.list({}).then((value) => {
      const options = workspaceOptions(value);
      setWorkspaces(options);
      setWorkspaceId((current) => current || options[0]?.id || "");
    }).catch((cause) => setError(messageOf(cause)));
  }, [setError]);

  const updateProfile = (patch: Partial<CustomOrchestratorDefinition>) => {
    if (!selected) return;
    setProfiles((current) => current.map((profile) => profile.id === selected.id
      ? { ...profile, ...patch }
      : profile));
  };

  const updateStage = (index: number, patch: Partial<OrchestrationStage>) => {
    if (!selected) return;
    updateProfile({
      stages: selected.stages.map((stage, stageIndex) => stageIndex === index
        ? { ...stage, ...patch }
        : stage),
    });
  };

  const addProfile = () => {
    const profile = defaultOrchestrator();
    setProfiles((current) => [...current, profile]);
    setSelectedId(profile.id);
  };

  const addStage = () => {
    if (!selected) return;
    const index = selected.stages.length + 1;
    updateProfile({
      stages: [...selected.stages, {
        id: `stage-${index}`,
        name: `Stage ${index}`,
        model: { providerId: "commandcode-proxy", model: "" },
        maxRetries: 2,
        approvalMode: "inherit",
        timeoutMs: 10 * 60 * 1000,
        completionRules: ["stage-complete"],
      }],
    });
  };

  const exportProfile = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
    setNotice(text(language, "Orchestrator JSON copied.", "已複製 Orchestrator JSON。"));
  };

  const prepareAnnealRun = async () => {
    const api = window.codingTools;
    if (!api) throw new Error("Coding Tools execution bridge is unavailable");
    if (!selected || !workspaceId || !taskId.trim()) {
      throw new Error("Select a workspace and enter an existing task ID");
    }
    if (!confirmRun) throw new Error("External Anneal execution must be approved");
    setBusy(true);
    setError(null);
    try {
      const initial = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
      const bindings = executionBindings(initial).filter((binding) => (
        binding.engine === "anneal"
        && binding.enabled
        && binding.connected
        && binding.current_scope_valid
      ));
      if (bindings.length === 0) throw new Error("Connect at least one approved Anneal provider binding first");

      const prepared: string[] = [];
      for (const stage of selected.stages) {
        const providerId = stageProvider(stage);
        const binding = bindings.find((candidate) => candidate.provider === providerId)
          ?? bindings.find((candidate) => candidate.model === stage.model?.model);
        if (!binding) throw new Error(`No connected Anneal binding for ${stage.name} (${providerId})`);

        const view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
        const missionId = sanitizeIdentifier(`${selected.id}-${stage.id}-${crypto.randomUUID().slice(0, 8)}`);
        await api.execution.update({
          workspaceId,
          expectedRevision: boardRevision(view),
          change: {
            operation: "agent_prepare",
            binding_id: binding.id,
            task_id: taskId.trim(),
            mission_id: missionId,
          },
          confirm: true,
        });
        const preparedView = await api.execution.read({ workspaceId, missionId, refreshSource: false });
        await api.execution.update({
          workspaceId,
          expectedRevision: missionRevision(preparedView, missionId),
          change: {
            operation: "agent_control",
            mission_id: missionId,
            request_key: crypto.randomUUID(),
            action: "create",
          },
          confirm: true,
        });
        prepared.push(missionId);
      }
      setNotice(text(
        language,
        `Prepared ${prepared.length} owned Anneal stage missions. Inspect source state before starting them.`,
        `已建立 ${prepared.length} 個 Anneal 階段任務。啟動前請先核對來源狀態。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="orchestrator-surface">
      <header className="surface-heading provider-heading">
        <div>
          <span className="surface-kicker">ANNEAL</span>
          <h1>{text(language, "Structured Orchestrator", "結構化 Orchestrator")}</h1>
          <p>{text(
            language,
            "Choose a provider and model for every stage, then prepare owned Anneal missions with explicit approval.",
            "為每個階段選擇供應商及模型，再以明確批准建立 Anneal 任務。",
          )}</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={addProfile} type="button">+ {text(language, "New profile", "新增設定")}</button>
          <button className="secondary-button" onClick={() => void exportProfile()} type="button">{text(language, "Copy JSON", "複製 JSON")}</button>
        </div>
      </header>

      <div className="orchestrator-toolbar">
        <label>
          <span>{text(language, "Profile", "設定檔")}</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <label>
          <span>{text(language, "Workspace", "工作區")}</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">—</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
          </select>
        </label>
        <label className="grow-field">
          <span>{text(language, "Existing board task ID", "現有看板任務 ID")}</span>
          <input value={taskId} onChange={(event) => setTaskId(event.target.value)} />
        </label>
      </div>

      {selected ? (
        <div className="orchestrator-editor">
          <section className="orchestrator-settings">
            <label>
              <span>{text(language, "Orchestrator name", "Orchestrator 名稱")}</span>
              <input value={selected.name} onChange={(event) => updateProfile({ name: event.target.value })} />
            </label>
            <label>
              <span>{text(language, "Description", "描述")}</span>
              <input value={selected.description ?? ""} onChange={(event) => updateProfile({ description: event.target.value })} />
            </label>
            <label className="check-row">
              <input checked={selected.enabled} onChange={(event) => updateProfile({ enabled: event.target.checked })} type="checkbox" />
              <span>{text(language, "Profile enabled", "啟用設定檔")}</span>
            </label>
          </section>

          <div className="stage-list">
            {selected.stages.map((stage, index) => (
              <article className="stage-card" key={`${stage.id}-${index}`}>
                <header>
                  <span className="stage-index">{index + 1}</span>
                  <input
                    aria-label={`Stage ${index + 1} name`}
                    value={stage.name}
                    onChange={(event) => updateStage(index, {
                      name: event.target.value,
                      id: sanitizeIdentifier(event.target.value.toLowerCase()),
                    })}
                  />
                </header>
                <div className="stage-grid">
                  <label>
                    <span>{text(language, "Provider", "供應商")}</span>
                    <select
                      value={stageProvider(stage)}
                      onChange={(event) => updateStage(index, {
                        model: { providerId: event.target.value, model: stage.model?.model ?? "" },
                      })}
                    >
                      {DEFAULT_PROVIDERS.filter((provider) => provider.annealEnabled).map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{text(language, "Model", "模型")}</span>
                    <input
                      value={stage.model?.model ?? ""}
                      onChange={(event) => updateStage(index, {
                        model: { providerId: stageProvider(stage), model: event.target.value },
                      })}
                    />
                  </label>
                  <label>
                    <span>{text(language, "Max retries", "最大重試")}</span>
                    <input
                      max={10}
                      min={0}
                      type="number"
                      value={stage.maxRetries}
                      onChange={(event) => updateStage(index, { maxRetries: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>{text(language, "Approval", "批准")}</span>
                    <select
                      value={stage.approvalMode}
                      onChange={(event) => updateStage(index, {
                        approvalMode: event.target.value as OrchestrationStage["approvalMode"],
                      })}
                    >
                      <option value="inherit">inherit</option>
                      <option value="required">required</option>
                      <option value="auto-approved">auto-approved</option>
                    </select>
                  </label>
                  <label>
                    <span>{text(language, "Timeout minutes", "逾時分鐘")}</span>
                    <input
                      max={60}
                      min={1}
                      type="number"
                      value={Math.round(stage.timeoutMs / 60_000)}
                      onChange={(event) => updateStage(index, {
                        timeoutMs: Math.max(1, Number(event.target.value)) * 60_000,
                      })}
                    />
                  </label>
                  <label>
                    <span>{text(language, "Completion rule", "完成規則")}</span>
                    <input
                      value={stage.completionRules[0] ?? ""}
                      onChange={(event) => updateStage(index, { completionRules: [event.target.value] })}
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>

          <div className="orchestrator-actions">
            <button className="secondary-button" onClick={addStage} type="button">+ {text(language, "Add stage", "新增階段")}</button>
            <label className="check-row approval-check">
              <input checked={confirmRun} onChange={(event) => setConfirmRun(event.target.checked)} type="checkbox" />
              <span>{text(language, "Approve external Anneal execution and provider costs", "批准外部 Anneal 執行及供應商費用")}</span>
            </label>
            <button
              className="primary-button compact"
              disabled={busy || !selected.enabled || !workspaceId || !taskId.trim() || !confirmRun}
              onClick={() => void prepareAnnealRun()}
              type="button"
            >
              {busy ? "…" : text(language, "Prepare Anneal run", "建立 Anneal 任務")}
            </button>
          </div>
          {notice ? <p className="inline-notice orchestrator-notice">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
