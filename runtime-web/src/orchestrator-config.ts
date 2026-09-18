import {
  getBuiltinProvider,
  providersForEngine,
  type ProviderCapability,
} from "./provider-registry";
import { resolveFallbackPolicy } from "./provider-runtime";

export type StageApprovalMode = "inherit" | "required" | "never";

export interface OrchestratorStage {
  id: string;
  name: string;
  role: string;
  providerId: string;
  fallbackProviderIds: string[];
  model: string;
  requiredCapabilities: ProviderCapability[];
  maxAttempts: number;
  timeoutMs: number;
  approval: StageApprovalMode;
}

export interface OrchestratorDefinition {
  id: string;
  name: string;
  engine: "anneal";
  parallel: boolean;
  requireApproval: boolean;
  maxBudgetMinutes: number;
  stages: OrchestratorStage[];
}

export interface AnnealStaffingProjection {
  schemaVersion: 1;
  orchestratorId: string;
  name: string;
  engine: "anneal";
  execution: {
    parallel: boolean;
    requireApproval: boolean;
    maxBudgetMinutes: number;
  };
  staff: Array<{
    stageId: string;
    role: string;
    providerId: string;
    fallbackProviderIds: string[];
    model?: string;
    requiredCapabilities: ProviderCapability[];
    maxAttempts: number;
    timeoutMs: number;
    approval: StageApprovalMode;
  }>;
}

const DEFAULT_STAGE_NAMES = ["Planner", "Coder", "Reviewer", "Tester"];

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "stage";
}

function uniqueStageId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function createDefaultOrchestrator(): OrchestratorDefinition {
  const providers = providersForEngine("anneal");
  const primary = providers[0]?.id ?? "commandcode-proxy";
  const fallback = providers.slice(1, 3).map((provider) => provider.id);

  return {
    id: "default-anneal-orchestrator",
    name: "Anneal delivery workflow",
    engine: "anneal",
    parallel: false,
    requireApproval: true,
    maxBudgetMinutes: 45,
    stages: DEFAULT_STAGE_NAMES.map((name, index) => ({
      id: `stage-${slug(name)}`,
      name,
      role: name.toLowerCase(),
      providerId: providers[index % Math.max(providers.length, 1)]?.id ?? primary,
      fallbackProviderIds: [...fallback],
      model: "",
      requiredCapabilities: index === 3 ? ["text", "tools"] : ["text", "reasoning"],
      maxAttempts: 3,
      timeoutMs: 10 * 60 * 1000,
      approval: "inherit",
    })),
  };
}

export function normalizeOrchestrator(
  definition: OrchestratorDefinition,
): OrchestratorDefinition {
  const usedIds = new Set<string>();
  const normalizedStages = definition.stages.map((stage, index) => {
    const name = stage.name.trim() || `Stage ${index + 1}`;
    const provider = getBuiltinProvider(stage.providerId);
    const capability = stage.requiredCapabilities[0];
    const fallbackPolicy = provider
      ? resolveFallbackPolicy(stage.providerId, stage.fallbackProviderIds, {
          engine: "anneal",
          capability,
        })
      : { primary: stage.providerId, fallback: [] };

    return {
      ...stage,
      id: uniqueStageId(slug(stage.id || name), usedIds),
      name,
      role: stage.role.trim() || slug(name),
      providerId: fallbackPolicy.primary,
      fallbackProviderIds: fallbackPolicy.fallback,
      model: stage.model.trim(),
      requiredCapabilities: [...new Set(stage.requiredCapabilities)],
      maxAttempts: Math.min(10, Math.max(1, Math.trunc(stage.maxAttempts || 1))),
      timeoutMs: Math.min(
        60 * 60 * 1000,
        Math.max(5_000, Math.trunc(stage.timeoutMs || 5_000)),
      ),
    };
  });

  return {
    ...definition,
    id: slug(definition.id || definition.name || "anneal-orchestrator"),
    name: definition.name.trim() || "Anneal orchestrator",
    engine: "anneal",
    maxBudgetMinutes: Math.min(
      24 * 60,
      Math.max(1, Math.trunc(definition.maxBudgetMinutes || 1)),
    ),
    stages: normalizedStages,
  };
}

export function validateOrchestrator(
  definition: OrchestratorDefinition,
): string[] {
  const errors: string[] = [];
  if (!definition.id.trim()) errors.push("Orchestrator id is required");
  if (!definition.name.trim()) errors.push("Orchestrator name is required");
  if (!Number.isInteger(definition.maxBudgetMinutes) || definition.maxBudgetMinutes < 1) {
    errors.push("Execution budget must be at least one minute");
  }
  if (definition.stages.length === 0) errors.push("At least one stage is required");
  if (definition.stages.length > 32) errors.push("At most 32 stages are supported");

  const ids = new Set<string>();
  for (const stage of definition.stages) {
    if (!stage.id.trim()) errors.push("Every stage requires an id");
    if (ids.has(stage.id)) errors.push(`Duplicate stage id: ${stage.id}`);
    ids.add(stage.id);
    if (!stage.name.trim()) errors.push(`Stage ${stage.id || "<unknown>"} requires a name`);
    if (!stage.role.trim()) errors.push(`Stage ${stage.id || "<unknown>"} requires a role`);

    const provider = getBuiltinProvider(stage.providerId);
    if (!provider) {
      errors.push(`Stage ${stage.id} uses unknown provider ${stage.providerId}`);
    } else if (!provider.annealEnabled) {
      errors.push(`Provider ${stage.providerId} is not enabled for Anneal`);
    }

    if (!Number.isInteger(stage.maxAttempts) || stage.maxAttempts < 1 || stage.maxAttempts > 10) {
      errors.push(`Stage ${stage.id} max attempts must be between 1 and 10`);
    }
    if (!Number.isInteger(stage.timeoutMs) || stage.timeoutMs < 5_000) {
      errors.push(`Stage ${stage.id} timeout must be at least 5000ms`);
    }
    if (stage.requiredCapabilities.length === 0) {
      errors.push(`Stage ${stage.id} requires at least one capability`);
    }
    for (const capability of stage.requiredCapabilities) {
      if (provider && !provider.capabilities.includes(capability)) {
        errors.push(`Provider ${stage.providerId} does not support ${capability}`);
      }
    }
    for (const fallbackId of stage.fallbackProviderIds) {
      const fallback = getBuiltinProvider(fallbackId);
      if (!fallback) errors.push(`Stage ${stage.id} has unknown fallback ${fallbackId}`);
      if (fallbackId === stage.providerId) {
        errors.push(`Stage ${stage.id} repeats its primary provider as fallback`);
      }
    }
  }

  return errors;
}

export function projectToAnneal(
  definition: OrchestratorDefinition,
): AnnealStaffingProjection {
  const normalized = normalizeOrchestrator(definition);
  const errors = validateOrchestrator(normalized);
  if (errors.length > 0) {
    throw new Error(`Invalid orchestrator: ${errors.join("; ")}`);
  }

  return {
    schemaVersion: 1,
    orchestratorId: normalized.id,
    name: normalized.name,
    engine: "anneal",
    execution: {
      parallel: normalized.parallel,
      requireApproval: normalized.requireApproval,
      maxBudgetMinutes: normalized.maxBudgetMinutes,
    },
    staff: normalized.stages.map((stage) => ({
      stageId: stage.id,
      role: stage.role,
      providerId: stage.providerId,
      fallbackProviderIds: [...stage.fallbackProviderIds],
      model: stage.model || undefined,
      requiredCapabilities: [...stage.requiredCapabilities],
      maxAttempts: stage.maxAttempts,
      timeoutMs: stage.timeoutMs,
      approval: stage.approval,
    })),
  };
}

export function parseOrchestrator(serialized: string): OrchestratorDefinition {
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Orchestrator document must be an object");
  }
  const normalized = normalizeOrchestrator(parsed as OrchestratorDefinition);
  const errors = validateOrchestrator(normalized);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return normalized;
}
