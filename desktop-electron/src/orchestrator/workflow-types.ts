import type {
  CustomOrchestratorDefinition,
  OrchestrationStage,
} from "../orchestration/paseo-anneal-types";

export type ResolvedStageTarget =
  | {
      kind: "agent";
      agentId: string;
      providerId: string;
      model: string;
    }
  | {
      kind: "orchestrator";
      orchestratorId: string;
      agentId?: string;
    };

export interface ResolvedWorkflowStage {
  id: string;
  name: string;
  target: ResolvedStageTarget;
  fallbackStageId?: string;
  maxRetries: number;
  approvalMode: OrchestrationStage["approvalMode"];
  timeoutMs: number;
  completionRules: string[];
}

export interface ResolvedWorkflowPlan {
  workflowId: string;
  name: string;
  entryStageId: string;
  ancestry: string[];
  stages: ResolvedWorkflowStage[];
}

export type { CustomOrchestratorDefinition, OrchestrationStage };
