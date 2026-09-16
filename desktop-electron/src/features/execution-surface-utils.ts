import type { Language } from "../types";

export interface WorkspaceOption {
  id: string;
  label: string;
}

export interface TaskOption {
  id: string;
  title: string;
  description: string;
  state: string;
}

export interface ExecutionBinding {
  id: string;
  engine: "paseo" | "anneal" | string;
  provider: string;
  model: string;
  endpoint: string;
  enabled: boolean;
  connected: boolean;
  currentScopeValid: boolean;
}

export interface MissionView {
  id: string;
  taskId: string;
  title: string;
  engine: string;
  provider: string;
  model: string;
  phase: string;
  revision: number;
  quiescent: boolean;
  lastStatus: string | null;
}

export function localText(
  language: Language,
  english: string,
  traditionalChinese: string,
  simplifiedChinese = traditionalChinese,
  japanese = english,
): string {
  if (language === "zh-TW") return traditionalChinese;
  if (language === "zh-CN") return simplifiedChinese;
  if (language === "ja") return japanese;
  return english;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function candidateArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const root = object(value);
  for (const key of keys) {
    const candidate = root?.[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function workspaceOptions(value: unknown): WorkspaceOption[] {
  return candidateArray(value, ["items", "workspaces", "data"]).flatMap((candidate) => {
    const row = object(candidate);
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id) return [];
    const name = typeof row?.name === "string" ? row.name : id;
    const workspacePath = typeof row?.path === "string" ? row.path : "";
    return [{ id, label: workspacePath ? `${name} · ${workspacePath}` : name }];
  });
}

export function taskOptions(value: unknown): TaskOption[] {
  return candidateArray(value, ["items", "tasks", "data"]).flatMap((candidate) => {
    const row = object(candidate);
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id) return [];
    return [{
      id,
      title: typeof row?.title === "string" ? row.title : id,
      description: typeof row?.description === "string" ? row.description : "",
      state: typeof row?.state === "string" ? row.state : "unknown",
    }];
  });
}

export function executionRoot(value: unknown): Record<string, unknown> {
  const root = object(value) ?? {};
  return object(root.execution) ?? root;
}

export function executionBindings(value: unknown): ExecutionBinding[] {
  const rows = executionRoot(value).bindings;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((candidate) => {
    const row = object(candidate);
    if (!row || typeof row.id !== "string") return [];
    return [{
      id: row.id,
      engine: typeof row.engine === "string" ? row.engine : "",
      provider: typeof row.provider === "string" ? row.provider : "",
      model: typeof row.model === "string" ? row.model : "",
      endpoint: typeof row.endpoint === "string" ? row.endpoint : "",
      enabled: row.enabled === true,
      connected: row.connected === true,
      currentScopeValid: row.current_scope_valid === true,
    }];
  });
}

export function boardRevision(value: unknown): number {
  const root = object(value) ?? {};
  return typeof root.revision === "number" ? root.revision : 0;
}

export function missionViews(value: unknown): MissionView[] {
  const rows = executionRoot(value).missions;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((candidate) => {
    const entry = object(candidate);
    const mission = object(entry?.mission);
    const spec = object(mission?.spec);
    const id = typeof spec?.mission_id === "string" ? spec.mission_id : "";
    if (!id) return [];
    return [{
      id,
      taskId: typeof spec?.task_id === "string" ? spec.task_id : "",
      title: typeof spec?.title === "string" ? spec.title : id,
      engine: typeof spec?.engine === "string" ? spec.engine : "",
      provider: typeof spec?.provider === "string" ? spec.provider : "",
      model: typeof spec?.model === "string" ? spec.model : "",
      phase: typeof mission?.phase === "string" ? mission.phase : "unknown",
      revision: typeof mission?.revision === "number" ? mission.revision : 0,
      quiescent: mission?.quiescent === true,
      lastStatus: typeof mission?.last_status === "string" ? mission.last_status : null,
    }];
  });
}

export function missionRevision(value: unknown, missionId: string): number {
  return missionViews(value).find((mission) => mission.id === missionId)?.revision ?? 0;
}

export function selectBinding(
  value: unknown,
  engine: "paseo" | "anneal",
  providerId: string,
  model: string | null,
): ExecutionBinding | undefined {
  const connected = executionBindings(value).filter((binding) => (
    binding.engine === engine
      && binding.enabled
      && binding.connected
      && binding.currentScopeValid
  ));
  return connected.find((binding) => (
    binding.provider === providerId && (!model || binding.model === model)
  )) ?? connected.find((binding) => binding.provider === providerId)
    ?? connected.find((binding) => !model || binding.model === model);
}

export function sanitizeIdentifier(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "mission";
}

export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
