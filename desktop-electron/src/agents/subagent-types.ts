import type { ProviderCapability } from "../providers/provider-types";

export type AgentKind = "model" | "orchestrator";

export type AgentRole =
  | "planner"
  | "coder"
  | "researcher"
  | "reviewer"
  | "tester"
  | "browser"
  | "monitor"
  | "supervisor"
  | "custom";

export type AgentTool =
  | "browser"
  | "filesystem"
  | "terminal"
  | "github"
  | "mcp"
  | "computer";

export type AgentPermissionMode =
  | "restricted"
  | "approval-required"
  | "auto-approved";

export interface AgentExecutionBudget {
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
}

interface AgentProfileBase {
  id: string;
  name: string;
  kind: AgentKind;
  role: AgentRole;
  enabled: boolean;
  capabilities: ProviderCapability[];
  tools: AgentTool[];
  permissionMode: AgentPermissionMode;
  budget: AgentExecutionBudget;
  systemPrompt?: string;
}

export interface ModelAgentProfile extends AgentProfileBase {
  kind: "model";
  providerId: string;
  model: string;
  orchestratorId?: never;
}

export interface OrchestratorAgentProfile extends AgentProfileBase {
  kind: "orchestrator";
  orchestratorId: string;
  providerId?: never;
  model?: never;
}

export type AgentProfile = ModelAgentProfile | OrchestratorAgentProfile;

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function validateAgentProfile(profile: AgentProfile): string[] {
  const candidate = profile as AgentProfile & Record<string, unknown>;
  const errors: string[] = [];

  if (!candidate.id?.trim()) errors.push("agent id is required");
  if (!candidate.name?.trim()) errors.push("agent name is required");
  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0) {
    errors.push("agent must declare at least one capability");
  }
  if (!Array.isArray(candidate.tools)) errors.push("agent tools must be an array");

  if (candidate.kind === "model") {
    if (typeof candidate.providerId !== "string" || !candidate.providerId.trim()) {
      errors.push("model agent requires providerId");
    }
    if (typeof candidate.model !== "string" || !candidate.model.trim()) {
      errors.push("model agent requires model");
    }
    if (candidate.orchestratorId !== undefined) {
      errors.push("model agent must not define orchestratorId");
    }
  } else if (candidate.kind === "orchestrator") {
    if (typeof candidate.orchestratorId !== "string" || !candidate.orchestratorId.trim()) {
      errors.push("orchestrator agent requires orchestratorId");
    }
    if (candidate.providerId !== undefined || candidate.model !== undefined) {
      errors.push("orchestrator agent must not define providerId or model");
    }
  } else {
    errors.push("agent kind must be model or orchestrator");
  }

  const budget = candidate.budget as AgentExecutionBudget | undefined;
  if (!budget || !isPositiveInteger(budget.maxTurns)) {
    errors.push("agent maxTurns must be a positive integer");
  }
  if (!budget || !isPositiveInteger(budget.timeoutMs)) {
    errors.push("agent timeoutMs must be a positive integer");
  }
  if (!budget || !Number.isInteger(budget.maxRetries) || budget.maxRetries < 0) {
    errors.push("agent maxRetries must be a non-negative integer");
  }

  return errors;
}
